import { createHash, randomBytes } from 'node:crypto';
import { BridgeError } from '../router/common.js';
import { validateToolValue } from './tool-schema.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const messageId = { type: 'string', minLength: 1, maxLength: 256 };
const option = objectSchema({
  id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,32}$', minLength: 1, maxLength: 32 },
  label: { type: 'string', minLength: 1, maxLength: 80 },
});
const status = {
  type: 'string',
  enum: ['none', 'pending', 'processing', 'sent', 'expired', 'dead', 'cancelled', 'uncertain'],
};

export function choiceDefinitions(channel) {
  const native = ['lark', 'telegram', 'discord'].includes(channel);
  const inputOption = native
    ? objectSchema(
        {
          ...option.properties,
          command: { type: 'string', enum: ['help', 'status', 'queue', 'subscription'] },
          reminder: objectSchema({
            outbound_id: {
              type: 'string',
              pattern: '^out_[a-f0-9]{64}$',
              minLength: 68,
              maxLength: 68,
            },
            expected_revision: { type: 'integer', minimum: 1 },
            action: { type: 'string', enum: ['pause', 'resume', 'cancel'] },
          }),
        },
        ['id', 'label'],
      )
    : option;
  const tools = [
    {
      name: `reply_${channel}_choices`,
      description:
        'Reply to this authorized source with a prompt and 1-10 choices. Native buttons/select menus are used where supported; other channels show numbered text. A clicked native choice must come from the same sender, chat and topic and creates one new owner input. This never approves a hosted-dot action. Reuse the same idempotency_key; it is one final reply.',
      inputSchema: objectSchema(
        {
          message_id: messageId,
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          choices: { type: 'array', minItems: 1, maxItems: 10, items: inputOption },
          presentation: { type: 'string', enum: ['buttons', 'select'] },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        ['message_id', 'text', 'choices', 'idempotency_key'],
      ),
      outputSchema: objectSchema({ message_id: messageId, status }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: `get_${channel}_choice_result`,
      description:
        'Read whether this source choice prompt is waiting, selected or expired. No message send, permission change or hosted-dot approval occurs.',
      inputSchema: objectSchema({ message_id: messageId }),
      outputSchema: objectSchema({
        message_id: messageId,
        state: { type: 'string', enum: ['waiting', 'selected', 'expired'] },
        selection: {
          type: ['object', 'null'],
          properties: option.properties,
          required: option.required,
          additionalProperties: false,
        },
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
  return native ? tools : tools.slice(0, 1);
}
export const isChoiceTool = (channel, name) =>
  choiceDefinitions(channel).some((tool) => tool.name === name);
export function validateChoiceArguments(channel, name, args) {
  try {
    const tool = choiceDefinitions(channel).find((tool) => tool.name === name);
    if (!tool) throw Error();
    validateToolValue(args, tool.inputSchema);
    if (args.text !== undefined && !args.text.trim()) throw Error();
    if (args.choices && new Set(args.choices.map((item) => item.id)).size !== args.choices.length)
      throw Error();
    if (args.choices?.some((item) => !item.label.trim())) throw Error();
    if (args.choices?.some((item) => item.reminder && item.command)) throw Error();
    return { ...args };
  } catch {
    throw new BridgeError('Invalid source choice arguments');
  }
}
export function projectChoiceResult(channel, call, result) {
  const tool = choiceDefinitions(channel).find((tool) => tool.name === call.name);
  if (!tool || result?.isError !== false) throw Error('Invalid choice result');
  validateToolValue(result.structuredContent, tool.outputSchema);
  if (result.structuredContent.message_id !== call.arguments.message_id)
    throw Error('Unbound choice result');
  return structuredClone(result.structuredContent);
}

export class SourceChoices {
  constructor({ db, seal, open, authorize, clock = Date.now }) {
    Object.assign(this, { db, seal, open, authorize, clock });
    db.exec(`CREATE TABLE IF NOT EXISTS dotbridge_choices(source_id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,selected INTEGER NOT NULL DEFAULT 0,dispatched INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS dotbridge_choice_tokens(token TEXT PRIMARY KEY,source_id TEXT NOT NULL);`);
  }
  tx(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  create(source, args) {
    this.authorize(source.id);
    const digest = hash(
      JSON.stringify({
        text: args.text,
        choices: args.choices,
        presentation: args.presentation ?? 'buttons',
        key: args.idempotency_key,
      }),
    );
    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT * FROM dotbridge_choices WHERE source_id=?')
        .get(source.id);
      if (existing) {
        if (existing.digest !== digest)
          throw new BridgeError('A different choice prompt already exists', {
            code: -32013,
            status: 409,
          });
        return this.open(existing.payload, 'choices:' + source.id).plan;
      }
      if (
        this.db
          .prepare('SELECT count(*) AS n FROM dotbridge_choices WHERE expires>?')
          .get(this.clock()).n >= 256
      )
        throw new BridgeError('Choice prompt capacity reached', { code: -32013, status: 429 });
      const choices = args.choices.map((item) => ({
        ...item,
        token: 'db_' + randomBytes(18).toString('base64url'),
      }));
      const text =
        args.text + '\n\n' + choices.map((item, index) => `${index + 1}. ${item.label}`).join('\n');
      const plan = {
        kind: 'choices',
        text,
        prompt: args.text,
        choices,
        presentation: args.presentation ?? 'buttons',
        idempotencyKey: args.idempotency_key,
      };
      const payload = {
        plan,
        binding: {
          senderId: source.senderId,
          conversationId: source.conversationId,
          threadId: source.threadId ?? null,
          chatType: source.chatType ?? 'private',
        },
        selection: null,
      };
      const expires = Math.min(source.expires, this.clock() + 600000);
      this.db
        .prepare('INSERT INTO dotbridge_choices(source_id,digest,payload,expires) VALUES (?,?,?,?)')
        .run(source.id, digest, this.seal(payload, 'choices:' + source.id), expires);
      for (const choice of choices)
        this.db
          .prepare('INSERT INTO dotbridge_choice_tokens VALUES (?,?)')
          .run(choice.token, source.id);
      return plan;
    });
  }
  bindPrompt(sourceId, messageId) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256) {
      throw Error('A verified prompt message receipt is required');
    }
    this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM dotbridge_choices WHERE source_id=?')
        .get(sourceId);
      if (!row) throw Error('Choice prompt is unavailable');
      const payload = this.open(row.payload, 'choices:' + sourceId);
      if (payload.binding.promptMessageId && payload.binding.promptMessageId !== messageId) {
        throw Error('Choice prompt receipt changed');
      }
      payload.binding.promptMessageId = messageId;
      this.db
        .prepare('UPDATE dotbridge_choices SET payload=? WHERE source_id=?')
        .run(this.seal(payload, 'choices:' + sourceId), sourceId);
    });
  }
  select(input) {
    if (!input || typeof input.token !== 'string' || !/^db_[A-Za-z0-9_-]{24}$/.test(input.token))
      return { accepted: false };
    const reference = this.db
      .prepare('SELECT source_id FROM dotbridge_choice_tokens WHERE token=?')
      .get(input.token);
    if (!reference) return { accepted: false };
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM dotbridge_choices WHERE source_id=?')
        .get(reference.source_id);
      if (!row || row.expires <= this.clock()) return { accepted: false };
      try {
        this.authorize(row.source_id);
      } catch {
        return { accepted: false };
      }
      const payload = this.open(row.payload, 'choices:' + row.source_id),
        binding = payload.binding;
      if (!binding.promptMessageId || input.message?.id !== binding.promptMessageId)
        return { accepted: false };
      if (
        input.senderId !== binding.senderId ||
        input.conversationId !== binding.conversationId ||
        (input.threadId ?? null) !== binding.threadId
      )
        return { accepted: false };
      const choice = payload.plan.choices.find((item) => item.token === input.token);
      if (!choice) return { accepted: false };
      if (row.selected)
        return {
          accepted: payload.selection?.choice.id === choice.id,
          label: payload.selection?.choice.label,
        };
      if (
        !input.message ||
        JSON.stringify(input.message).length > 16384 ||
        input.message.senderId !== binding.senderId ||
        input.message.conversationId !== binding.conversationId ||
        (input.message.threadId ?? null) !== binding.threadId
      )
        return { accepted: false };
      const message = {
        ...input.message,
        chatType: binding.chatType,
        text: choice.command ? '/' + choice.command : `[选择 ${choice.id}] ${choice.label}`,
        timestamp: this.clock(),
        replyContext: { ...input.message.replyContext, choiceSourceId: row.source_id },
      };
      payload.selection = {
        choice: { id: choice.id, label: choice.label },
        message,
        ...(choice.reminder ? { reminder: choice.reminder } : {}),
      };
      this.db
        .prepare(
          'UPDATE dotbridge_choices SET payload=?,selected=1 WHERE source_id=? AND selected=0',
        )
        .run(this.seal(payload, 'choices:' + row.source_id), row.source_id);
      return { accepted: true, label: choice.label };
    });
  }
  result(sourceId) {
    this.authorize(sourceId);
    const row = this.db.prepare('SELECT * FROM dotbridge_choices WHERE source_id=?').get(sourceId);
    if (!row) throw new BridgeError('Choice prompt unavailable', { code: -32012, status: 403 });
    const payload = this.open(row.payload, 'choices:' + sourceId);
    return {
      message_id: sourceId,
      state:
        row.dispatched === 2
          ? 'expired'
          : row.selected
            ? 'selected'
            : row.expires <= this.clock()
              ? 'expired'
              : 'waiting',
      selection: payload.selection?.choice ?? null,
    };
  }
  async dispatch(ingest, applyReminder) {
    for (const row of this.db
      .prepare(
        'SELECT * FROM dotbridge_choices WHERE selected=1 AND dispatched=0 ORDER BY rowid LIMIT 10',
      )
      .all()) {
      try {
        this.authorize(row.source_id);
      } catch {
        this.db
          .prepare('UPDATE dotbridge_choices SET dispatched=2 WHERE source_id=?')
          .run(row.source_id);
        continue;
      }
      const payload = this.open(row.payload, 'choices:' + row.source_id);
      if (payload.selection.reminder && !payload.selection.actionCompleted) {
        if (typeof applyReminder !== 'function')
          throw Error('Reminder button integration unavailable');
        const action = payload.selection.reminder;
        let status;
        try {
          status = applyReminder(action).status;
        } catch (error) {
          if (!(error instanceof BridgeError)) throw error;
          status = 'refused';
        }
        payload.selection.message.text += '\n提醒 ' + action.outbound_id + ' · ' + status;
        payload.selection.actionCompleted = true;
        this.db
          .prepare('UPDATE dotbridge_choices SET payload=? WHERE source_id=?')
          .run(this.seal(payload, 'choices:' + row.source_id), row.source_id);
      }
      await ingest(payload.selection.message);
      this.db
        .prepare('UPDATE dotbridge_choices SET dispatched=1 WHERE source_id=?')
        .run(row.source_id);
    }
    this.db
      .prepare(
        'DELETE FROM dotbridge_choice_tokens WHERE source_id IN (SELECT source_id FROM dotbridge_choices WHERE expires<=? AND (selected=0 OR dispatched=1))',
      )
      .run(this.clock());
    this.db
      .prepare('DELETE FROM dotbridge_choices WHERE expires<=? AND (selected=0 OR dispatched=1)')
      .run(this.clock());
    this.db
      .prepare(
        'DELETE FROM dotbridge_choice_tokens WHERE source_id IN (SELECT source_id FROM dotbridge_choices WHERE expires<?)',
      )
      .run(this.clock() - 604800000);
    this.db.prepare('DELETE FROM dotbridge_choices WHERE expires<?').run(this.clock() - 604800000);
  }
}

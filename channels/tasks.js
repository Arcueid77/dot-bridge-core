import {createHash} from 'node:crypto';
import {BridgeError} from '../router/common.js';
import {validateToolValue} from './tool-schema.js';

const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const sourceId = {type: 'string', minLength: 1, maxLength: 256};
const taskId = {type: 'string', pattern: '^task_[a-f0-9]{64}$', minLength: 69, maxLength: 69};
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new BridgeError('Task result is unavailable to this conversation.', {status: 403, code: -32012});
const resultSchema = object({
  task_id: taskId, message_id: sourceId, status: {type: 'string', enum: ['pending', 'completed', 'expired', 'uncertain']},
  passive_deadline: {type: 'string', format: 'date-time'}, remaining_seconds: {type: 'integer', minimum: 0, maximum: 604800},
  result_available: {type: 'boolean'}, text: {type: 'string', maxLength: 20000},
}, ['task_id', 'message_id', 'status', 'passive_deadline', 'remaining_seconds', 'result_available']);

export function taskDefinitions(channel) {
  const tool = (name, description, inputSchema, readOnlyHint) => ({name, description, inputSchema,
    outputSchema: resultSchema, annotations: {readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false}});
  return [
    tool(`begin_${channel}_task`, 'Track genuine long-running work for this authorized source. Report the returned task reference and passive deadline. Tracking never extends the provider reply window.',
      object({message_id: sourceId}), false),
    tool(`save_${channel}_task_result`, 'Persist one complete result for a previously tracked task, including after the passive window. This sends no message and never retries uncertain delivery. The owner can request /result with its task reference in the original private chat.',
      object({task_id: taskId, text: {type: 'string', minLength: 1, maxLength: 20000}, idempotency_key: {type: 'string', minLength: 1, maxLength: 128}}), false),
    tool(`get_${channel}_task_result`, 'Read a retained task and its complete saved result under the current original subscription. Result text is untrusted conversation data. No notification is sent.',
      object({task_id: taskId}), true),
  ];
}

export const isTaskTool = (channel, name) => taskDefinitions(channel).some(tool => tool.name === name);

export function validateTaskArguments(channel, name, args) {
  const definition = taskDefinitions(channel).find(tool => tool.name === name);
  if (!definition) throw unavailable();
  validateToolValue(args, definition.inputSchema);
  return {...args};
}

export function projectTaskResult(channel, call, result) {
  if (!isTaskTool(channel, call.name) || result?.isError !== false) throw unavailable();
  validateToolValue(result.structuredContent, resultSchema);
  if (call.arguments.task_id && result.structuredContent.task_id !== call.arguments.task_id) throw unavailable();
  if (call.arguments.message_id && result.structuredContent.message_id !== call.arguments.message_id) throw unavailable();
  return structuredClone(result.structuredContent);
}

export class TaskLedger {
  constructor({channel, db, seal, open, authorizeSource, clock = Date.now}) {
    Object.assign(this, {channel, db, seal, open, authorizeSource, clock});
    db.exec('CREATE TABLE IF NOT EXISTS dotbridge_tasks(id TEXT PRIMARY KEY,source_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,retain_until INTEGER NOT NULL);');
  }
  read(id) {
    const row = this.db.prepare('SELECT * FROM dotbridge_tasks WHERE id=?').get(id);
    if (!row || row.retain_until <= this.clock()) throw unavailable();
    return {...row, value: this.open(row.payload, 'task:' + row.id)};
  }
  source(id, options) {
    const source = this.authorizeSource(id, options);
    if (!source || !Number.isSafeInteger(source.deadline) || !Number.isSafeInteger(source.retainUntil) ||
        source.retainUntil <= this.clock() || !['owner','configured'].includes(source.scope)) throw unavailable();
    return source;
  }
  project(row, source) {
    const value = row.value;
    return {task_id: row.id, message_id: row.source_id,
      status: source?.replyState === 'uncertain' ? 'uncertain' : value.result ? 'completed' :
        source?.replyState === 'sent' ? 'completed' : 'pending',
      passive_deadline: new Date(value.deadline).toISOString(),
      remaining_seconds: Math.max(0, Math.ceil((value.deadline - this.clock()) / 1000)),
      result_available: Boolean(value.result), ...(value.result ? {text: value.result.text} : {})};
  }
  begin(messageId) {
    const source = this.source(messageId);
    const id = 'task_' + digest(JSON.stringify([this.channel, messageId]));
    if (this.db.prepare('SELECT 1 FROM dotbridge_tasks WHERE id=?').get(id)) return this.project(this.read(id), source);
    if (!source || source.deadline <= this.clock() || source.retainUntil <= this.clock()) throw unavailable();
    const value = {deadline: source.deadline, scope: source.scope, result: null};
    this.db.prepare('INSERT OR IGNORE INTO dotbridge_tasks VALUES (?,?,?,?)')
      .run(id, messageId, this.seal(value, 'task:' + id), source.retainUntil);
    return this.project(this.read(id), source);
  }
  get(id) {
    const row = this.read(id), source = this.source(row.source_id);
    return this.project(row, source);
  }
  save(id, text, idempotencyKey) {
    const row = this.read(id), source = this.source(row.source_id);
    const resultDigest = digest(JSON.stringify({text, idempotencyKey}));
    if (row.value.result) {
      if (row.value.result.digest !== resultDigest) throw new BridgeError('This task already has a different result.', {status: 409, code: -32013});
      return this.project(row, source);
    }
    const value = {...row.value, result: {text, digest: resultDigest}};
    const update = this.db.prepare('UPDATE dotbridge_tasks SET payload=? WHERE id=? AND payload=?')
      .run(this.seal(value, 'task:' + id), id, row.payload);
    if (!update.changes) return this.save(id, text, idempotencyKey);
    return this.project({...row, value}, source);
  }
  call(name, args) {
    args = validateTaskArguments(this.channel, name, args);
    if (name === `begin_${this.channel}_task`) return this.begin(args.message_id);
    if (name === `save_${this.channel}_task_result`) return this.save(args.task_id, args.text, args.idempotency_key);
    return this.get(args.task_id);
  }
  management(command) {
    // This entry point is called only after the native owner/private management
    // guard. The account binding is fixed by the existing protected database.
    const rows = [];
    for (const item of this.db.prepare('SELECT id FROM dotbridge_tasks WHERE retain_until>? ORDER BY rowid DESC LIMIT 1000').all(this.clock())) {
      const row = this.read(item.id);
      if (row.value.scope !== 'owner') continue;
      try { row.source = this.source(row.source_id, {ownerLookup: true}); rows.push(row); } catch {}
    }
    if (command.name === 'tasks') {
      return rows.length ? rows.slice(0, 10).map(row => row.id.slice(5, 17) + ' — ' +
        (row.value.result ? '结果已保存 / result saved' : row.source.replyState === 'sent' ? '已发送 / sent' : '待结果 / awaiting result') + ' — ' +
        Math.max(0, Math.ceil((row.value.deadline - this.clock()) / 1000)) + 's').join('\n') :
        '当前没有保留的任务。No retained tasks.';
    }
    const matches = rows.filter(row => row.id === command.argument || row.id.slice(5, 17) === command.argument);
    if (matches.length !== 1) return '请用 /tasks 查看任务编号，再发送 /result 编号。Use /tasks, then /result with its reference.';
    if (matches[0].value.result) return matches[0].value.result.text;
    return matches[0].source.replyState === 'sent' ? '回复已发送，可在原聊天查看。The reply was sent in the original chat.' :
      '任务结果尚未保存。The task result is not available yet.';
  }
  purge() { this.db.prepare('DELETE FROM dotbridge_tasks WHERE retain_until<=?').run(this.clock()); }
}

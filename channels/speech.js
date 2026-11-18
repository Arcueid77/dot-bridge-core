import {createHash} from 'node:crypto';
import {BridgeError} from '../router/common.js';
import {validateToolValue} from './tool-schema.js';
import {createSpeechSynthesizer, MAX_M4A_SPEECH_SECONDS, MAX_SPEECH_SECONDS} from '../audio/synthesis.js';

const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const messageId = {type: 'string', minLength: 1, maxLength: 256};
const outcome = object({message_id: messageId,
  status: {type: 'string', enum: ['none','pending','processing','sent','expired','dead','cancelled','uncertain']}});
const defaults = {qq: ['wav','audio'], weixin: ['wav','audio'], lark: ['opus','audio'],
  telegram: ['opus','audio'], discord: ['opus','audio'], line: ['m4a','audio'],
  dingtalk: ['wav','file'], wecom: ['wav','file']};
const mimeTypes = {wav: 'audio/wav', opus: 'audio/ogg', mp3: 'audio/mpeg', amr: 'audio/amr'};
const m4aMimeType = 'audio/mp4';
const durationLimit = id => id === 'line' ? MAX_M4A_SPEECH_SECONDS : MAX_SPEECH_SECONDS;

export function speechDefinitions(channel) {
  const id = typeof channel === 'string' ? channel : channel.id;
  if (typeof channel !== 'string' && !channel.media?.reply.includes('audio')) return [];
  const tool = (name, description, inputSchema, outputSchema, readOnlyHint) => ({name, description, inputSchema, outputSchema,
    annotations: {readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false}});
  return [
    tool(`check_${id}_speech`, 'Inspect protected local text-to-speech configuration, runtime and reply type. These observations describe local preparation; actual audio delivery uses the ordinary provider acknowledgement.', object({}), object({
      configured: {type: 'boolean'}, runtime_ready: {type: 'boolean'}, reply_configured: {type: 'boolean'},
      delivery_kind: {type: 'string', enum: ['audio','file']}, mime_type: {type: 'string', enum: id==='line'?[m4aMimeType]:Object.values(mimeTypes)},
      max_text_chars: {type: 'integer', const: 2000}, max_duration_seconds: {type: 'integer', const: durationLimit(id)},
      busy: {type: 'boolean'}, last_failure: {type: ['string','null'], enum: ['synthesis','normalize','encode',null]},
    }), true),
    tool(`reply_${id}_speech`, 'Synthesize this genuinely generated answer using the configured local voice and queue one audio or file reply in the original source conversation. Use the same idempotency_key for retries and inspect uncertain status. The complete text is retained in the tracked task for explicit owner lookup.',
      object({message_id: messageId, text: {type: 'string', minLength: 1, maxLength: 2000},
        idempotency_key: {type: 'string', minLength: 1, maxLength: 128}}), outcome, false),
  ];
}

export const isSpeechTool = (channel, name) => speechDefinitions(channel).some(tool => tool.name === name);
export function validateSpeechArguments(channel, name, args) {
  const tool = speechDefinitions(channel).find(value => value.name === name);
  if (!tool) throw new BridgeError('Speech operation is unavailable.');
  validateToolValue(args, tool.inputSchema);
  return {...args};
}
export function projectSpeechResult(channel, call, result) {
  const tool = speechDefinitions(channel).find(value => value.name === call.name);
  if (!tool || result?.isError !== false) throw new BridgeError('Invalid speech result.');
  validateToolValue(result.structuredContent, tool.outputSchema);
  if (call.arguments.message_id && result.structuredContent.message_id !== call.arguments.message_id) throw new BridgeError('Unbound speech result.');
  return structuredClone(result.structuredContent);
}

export class SourceSpeech {
  constructor({channel, authorize, authorizeRead = authorize, existing, queue, status, begin, recordResult,
    providerReady = () => true, signal, env = process.env, synthesizer = createSpeechSynthesizer({env})}) {
    const id = typeof channel === 'string' ? channel : channel.id;
    const [format, type] = defaults[id] ?? ['wav','audio'];
    this.profile = {format, type};
    Object.assign(this, {channel: id, authorize, authorizeRead, existing, queue, status, begin, recordResult, providerReady, signal, synthesizer});
    this.work = new Map();
  }
  check() {
    return {...this.synthesizer.status(), reply_configured: this.providerReady() === true,
      delivery_kind: this.profile.type, mime_type: this.profile.format==='m4a'?m4aMimeType:mimeTypes[this.profile.format],
      max_text_chars: 2000, max_duration_seconds: durationLimit(this.channel)};
  }
  async reply(args) {
    args = validateSpeechArguments(this.channel, `reply_${this.channel}_speech`, args);
    const id = args.message_id;
    this.authorizeRead(id);
    const digest = createHash('sha256').update(JSON.stringify({text: args.text, key: args.idempotency_key})).digest('hex');
    const previous = this.existing(id);
    if (previous) {
      if (previous.digest !== digest) throw new BridgeError('A different final reply already exists.', {status: 409, code: -32013});
      return this.status(id);
    }
    if (this.status(id).status === 'uncertain') return this.status(id);
    this.authorize(id);
    const running = this.work.get(id);
    if (running) {
      if (running.digest !== digest) throw new BridgeError('A different speech reply is being prepared.', {status: 409, code: -32013});
      await running.promise;
      return this.status(id);
    }
    const task=this.begin?.(id);
    if(task?.result_available===true&&task.text!==args.text)throw new BridgeError('This task already retains a different complete answer.',{status:409,code:-32013});
    this.recordResult?.(id, args.text, digest);
    const readiness = this.check();
    if (!readiness.runtime_ready || !readiness.reply_configured) throw new BridgeError('Local speech reply preparation is unavailable.', {status: 409, code: -32016});
    const promise = this.prepare(args, digest);
    this.work.set(id, {digest, promise});
    try { await promise; return this.status(id); }
    finally { this.work.delete(id); }
  }
  async prepare(args, digest) {
    let audio;
    try {
      audio = await this.synthesizer.generate(args.text, {format: this.profile.format,
        authorize: () => this.authorizeRead(args.message_id), signal: this.signal});
      this.authorizeRead(args.message_id);
      if (this.existing(args.message_id)) throw new BridgeError('A final reply was queued while speech was being prepared.', {status: 409, code: -32013});
      this.authorize(args.message_id);
      await this.queue(args.message_id, {...audio, type: this.profile.type,
        idempotencyKey: args.idempotency_key, speechRequestDigest: digest});
    } finally { audio?.data.fill(0); }
  }
  async close() { await Promise.allSettled([...this.work.values()].map(value => value.promise)); }
}

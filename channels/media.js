import {BridgeError, object, RICH_TOOL_RESULT} from '../router/common.js';

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_BASE64 = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
// A rich result includes metadata (including a UTF-8 transcript) twice.
export const MEDIA_RPC_LIMIT = MAX_MEDIA_BASE64 + 131072;
const types = ['image', 'audio', 'file'];
const bad = () => new BridgeError('Media type, format, size or name is unsupported');

export function mediaCapabilities(channel) {
  const value = channel.media ?? {read: [], reply: []};
  object(value, ['read', 'reply'], ['read', 'reply']);
  for (const list of [value.read, value.reply]) {
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(type => !types.includes(type))) throw bad();
  }
  return value;
}

export function mediaName(value = 'attachment') {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\\/\u0000-\u001f\u007f]|\p{Surrogate}/u.test(value) || value === '.' || value === '..') throw bad();
  return value;
}

export function mediaMime(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)) throw bad();
  return value;
}

export function decodeMedia(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_MEDIA_BASE64 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw bad();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES || bytes.toString('base64') !== value) { bytes.fill(0); throw bad(); }
  return bytes;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}

export function validateMedia({type, data, mimeType, name}) {
  if (!types.includes(type) || !Buffer.isBuffer(data) || !data.length || data.length > MAX_MEDIA_BYTES) throw bad();
  mediaMime(mimeType); mediaName(name);
  if (type === 'image' && imageType(data) !== mimeType) throw bad();
  if (type === 'audio' && !mimeType.startsWith('audio/')) throw bad();
}

function binaryBlock(value, data) {
  if (value.kind === 'image') return {type:'image', mimeType:value.mime_type, data};
  if (value.kind === 'audio' && ['audio/wav','audio/x-wav','audio/mpeg','audio/ogg','audio/mp4','audio/webm','audio/flac','audio/aac'].includes(value.mime_type)) return {type:'audio', mimeType:value.mime_type, data};
  return {type:'resource', resource:{uri:`dotbridge://attachment/${encodeURIComponent(value.message_id)}/${value.attachment_index}`, mimeType:value.mime_type, blob:data}};
}

export function attachmentResult(value, bytes) {
  const content = [{type:'text', text:JSON.stringify(value)}, binaryBlock(value, bytes.toString('base64'))];
  return {[RICH_TOOL_RESULT]:true, value, content};
}

// An upstream cannot smuggle extra text, remote URLs, paths or content blocks
// through an otherwise valid structured result. Rebuild the content ourselves.
export function projectAttachment(call, result) {
  const value = result.structuredContent;
  if (value.message_id !== call.arguments.message_id || value.attachment_index !== call.arguments.attachment_index || !Array.isArray(result.content) || result.content.length !== 2) throw bad();
  const block = result.content[1];
  const encoded = value.kind === 'image' || (value.kind === 'audio' && block?.type === 'audio') ? block?.data : block?.resource?.blob;
  const bytes = decodeMedia(encoded);
  try {
    validateMedia({type:value.kind, data:bytes, mimeType:value.mime_type, name:value.name});
    if (bytes.length !== value.size || JSON.stringify(block) !== JSON.stringify(binaryBlock(value, encoded))) throw bad();
    return attachmentResult(value, bytes);
  } finally { bytes.fill(0); }
}

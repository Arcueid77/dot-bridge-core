import { isIP } from 'node:net';
import { BridgeError, object } from './common.js';
import { projectCallbackTransportStatus, callbackTransportStatusSchema, TRANSPORT_ERROR_CODES } from '../packages/dot-bridge-transport/index.js';
export const MAX_LEASE_MS = 604800000;
const statuses = new Set(['none','pending','processing','sent','expired','dead','cancelled','uncertain']);
const transportReasons = new Set([...TRANSPORT_ERROR_CODES, ...callbackTransportStatusSchema.properties.reason.enum.filter(reason=>reason!=='none')]);
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const unavailable = () => new BridgeError('Local bridge request unavailable or incompatible', { status: 502, code: -32030 });
export const forbidden = () => new BridgeError('Operation is not enabled for this channel', { status: 403, code: -32012 });
export function enabled(config, channel) { return config.operation === 'live' && config.liveChannels.includes(channel); }
export function validateToolCall(config,params){
  object(params,['name','arguments','_meta'],['name','arguments']);
  if(typeof params.name!=='string')throw forbidden();
  const match=Object.entries(config.channels).find(([,route])=>route.adapter.readinessTool.name===params.name||route.adapter.liveTools.some(t=>t.name===params.name));
  if(!match)throw forbidden();const [channel,{adapter}]=match,live=enabled(config,channel);
  if(!live&&params.name!==adapter.readinessTool.name)throw forbidden();
  return {channel,name:params.name,arguments:adapter.validateToolArguments(params.name,params.arguments,live)};
}
export function validateEventCall(config,method,params){
  if(config.operation!=='live'||!['events/subscribe','events/unsubscribe'].includes(method))throw forbidden();
  const subscribe=method==='events/subscribe';
  object(params,subscribe?['name','arguments','delivery','cursor','ttlMs','_meta']:['name','arguments','delivery','_meta'],['name','arguments','delivery']);
  if(typeof params.name!=='string')throw forbidden();
  const match=Object.entries(config.channels).find(([,route])=>route.adapter.event.name===params.name);
  if(!match||!enabled(config,match[0]))throw forbidden();
  const [channel,{adapter}]=match;
  object(params.arguments,['conversation'],['conversation']);if(!adapter.scopes.includes(params.arguments.conversation))throw forbidden();
  object(params.delivery,subscribe?['mode','url','secret']:['mode','url'],subscribe?['mode','url','secret']:['mode','url']);
  if(params.delivery.mode!=='webhook')throw new BridgeError('Only webhook delivery is supported');callbackUrl(params.delivery.url);
  if(subscribe){signingSecret(params.delivery.secret);if(params.cursor!==undefined&&params.cursor!==null)throw new BridgeError('Replay cursors are unsupported');
    if(params.ttlMs!==undefined&&params.ttlMs!==null&&(!Number.isSafeInteger(params.ttlMs)||params.ttlMs<=0||params.ttlMs>MAX_LEASE_MS))throw new BridgeError('Invalid bounded ttlMs');}
  return {channel,params:{name:params.name,arguments:{conversation:params.arguments.conversation},delivery:{mode:'webhook',url:params.delivery.url,...(subscribe?{secret:params.delivery.secret}:{})},
    ...(subscribe&&Object.hasOwn(params,'cursor')?{cursor:params.cursor}:{}),...(subscribe&&Object.hasOwn(params,'ttlMs')?{ttlMs:params.ttlMs}:{})}};
}
export function projectToolResult(config,call,result,live){try{return config.channels[call.channel].adapter.projectToolResult(call,result,live);}catch{throw unavailable();}}
export function boundedString(value, max, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || Buffer.byteLength(value) > max * 4 ||
      /\p{Surrogate}/u.test(value) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) throw new BridgeError('Invalid bounded string');
  return value;
}
export function validHostname(value) {
  return typeof value === 'string' && value.length <= 253 && !isIP(value) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
export function callbackUrl(value) {
  boundedString(value, 2048);
  let url; try { url = new URL(value); } catch { throw new BridgeError('Invalid callback URL'); }
  if (value !== value.trim() || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !validHostname(url.hostname)) throw new BridgeError('Invalid callback URL');
  return url;
}
function signingSecret(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BridgeError('Invalid webhook signing secret');
  const encoded = value.slice(6), bytes = Buffer.from(encoded, 'base64');
  try { if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new BridgeError('Invalid webhook signing secret'); }
  finally { bytes.fill(0); }
}
export function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw unavailable();
  return value;
}
export function projectStatus(value,id) {
  object(value,['message_id','status','error'],['message_id','status','error']);
  if (value.message_id !== id || !statuses.has(value.status) || !(value.error === null || typeof value.error === 'string')) throw unavailable();
  return {message_id:id,status:value.status,error:value.error === null ? null : 'backend_reported_error'};
}
export function projectPendingMessage(value,transport,configured) {
  if(transport?.mode!=='owner_single_message_proxy')throw unavailable();
  if(value===null)return null;
  object(value,['message_id','reply_deadline'],['message_id','reply_deadline']);
  const id=boundedString(value.message_id,256),deadline=iso(value.reply_deadline);
  if(!configured)throw unavailable();
  return Date.parse(deadline)>Date.now()?{message_id:id,reply_deadline:deadline}:null;
}
export function projectPendingMessages(value,transport,configured) {
  if(!['owner_scoped_proxy','direct'].includes(transport.mode)||!Array.isArray(value)||value.length>10||(!configured&&value.length))throw unavailable();
  const ids=new Set(),now=Date.now(),pending=[];
  for(const item of value){
    object(item,['message_id','reply_deadline','reply_status'],['message_id','reply_deadline','reply_status']);
    const id=boundedString(item.message_id,256),deadline=iso(item.reply_deadline);
    if(ids.has(id)||!['none','pending','processing'].includes(item.reply_status))throw unavailable();
    ids.add(id);
    if(Date.parse(deadline)>now)pending.push({message_id:id,reply_deadline:deadline,reply_status:item.reply_status});
  }
  return pending;
}
export function projectSubscription(result,params,startedAt) {
  try {
    object(result,['resultType','_meta','id','refreshBefore','cursor','truncated'],['id','refreshBefore','cursor','truncated']);
    if (typeof result.id !== 'string' || !/^sub_[a-f0-9]{64}$/.test(result.id) || result.cursor !== null || result.truncated !== false) throw unavailable();
    const expiry=Date.parse(iso(result.refreshBefore)), ceiling=Date.now()+(params.ttlMs ?? MAX_LEASE_MS);
    if (expiry <= Date.now() || expiry > ceiling) throw unavailable();
    return {id:result.id,refreshBefore:result.refreshBefore,cursor:null,truncated:false};
  } catch { throw unavailable(); }
}

// The sole error-data exception is an approval-needed hostname derived from the
// caller's own validated callback. No backend exception text or other data leaks.
export function projectUpstreamError(value,params,{method,adapter}={}) {
  const e=value?.error;
  if(method==='events/subscribe'&&record(e)&&e.code===-32015&&record(e.data)&&
      typeof e.data.reason==='string'&&transportReasons.has(e.data.reason)){
    let transport;
    try { if(e.data.callback_transport!==undefined)transport=projectCallbackTransportStatus(e.data.callback_transport); }
    catch { return unavailable(); }
    return new BridgeError('Selected backend callback transport is unavailable or rejected the request',
      {status:503,code:-32015,data:{reason:e.data.reason,...(transport?{callback_transport:transport}:{})}});
  }
  const policyRequired=record(e)&&record(e.data)&&adapter?.isCallbackPolicyError(e)===true;
  if (method === 'events/subscribe' && policyRequired && params.delivery?.url) {
    let host; try { host=callbackUrl(params.delivery.url).hostname; } catch { return unavailable(); }
    if (e.data.callback_hostname === host) return new BridgeError('Callback hostname requires separate approval',
      {status:403,code:-32015,data:{reason:'callback_policy_required',callback_hostname:host}});
  }
  const messages = new Map([[-32012,'Selected backend rejected authorization or message access'],[-32013,'Selected backend limit reached'],
    [-32014,'Selected backend does not support this event option'],[-32015,'Selected backend callback validation failed'],[-32602,'Selected backend rejected operation parameters']]);
  if (record(e) && messages.has(e.code)) return new BridgeError(messages.get(e.code),{status:400,code:e.code});
  return unavailable();
}


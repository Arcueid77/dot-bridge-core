import {validHostname,callbackUrl,boundedString} from '../router/live-contract.js';
import {object} from '../router/common.js';
import {MAX_MEDIA_BYTES,MEDIA_RPC_LIMIT,TUNNEL_ENVELOPE_BYTES} from './tunnel-budget.js';

export const diagnosticStages = ['validate','policy','transport','challenge','persist','complete'];
export const diagnosticReasons = ['invalid_request','callback_policy_required','transport_unavailable','challenge_failed','timeout','subscription_conflict','subscription_cancelled','storage_unavailable','subscribed'];
export const connectionStages = ['gateway','callback_policy','subscription','ready'];
export const connectionReasons = ['gateway_disconnected','callback_hosts_empty','callback_host_not_allowlisted','subscription_missing','subscription_expired','subscription_disabled','subscription_unknown','subscription_failed','ready'];
export const connectionNextSteps = ['check_gateway','approve_callback_hostname','subscribe_in_original_dot','renew_in_original_dot','inspect_subscription_diagnostics','none'];

export function subscriptionDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-5).flatMap(item => {
    if (!item || !diagnosticStages.includes(item.stage) || !diagnosticReasons.includes(item.reason) ||
        typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) ||
        !(item.code === null || (Number.isInteger(item.code) && item.code >= -32768 && item.code <= -32000)) ||
        !(item.hostname === null || validHostname(item.hostname))) return [];
    return [{at:new Date(item.at).toISOString(),stage:item.stage,code:item.code,reason:item.reason,hostname:item.hostname}];
  });
}

export function subscriptionStatus(record, now, diagnostics) {
  const validExpiry = Number.isSafeInteger(record?.expires) && record.expires >= 0 && record.expires <= 8640000000000000;
  const state = record == null ? 'none' : record.active === false ? 'disabled' : record.active !== true || !validExpiry ? 'unknown' : record.expires <= now ? 'expired' : 'active';
  return {state,expires_at:validExpiry ? new Date(record.expires).toISOString() : null,
    remaining_seconds:validExpiry ? Math.max(0,Math.floor((record.expires-now)/1000)) : null,
    renewal_owner:'host',diagnostics_available:diagnostics.length > 0};
}

export function connectionStatus({gatewayConnected,callbackHosts,subscription,diagnostics,callbackAllowed,legacyAliasPresent,settingName='CALLBACK_HOSTS',wrongSettingPresent=legacyAliasPresent,gatewayRequiresSubscription=false}) {
  if (!['CALLBACK_HOSTS','MCP_CALLBACK_ALLOWED_HOSTS'].includes(settingName)) throw Error('Unsupported callback setting name');
  let stage='ready',reason='ready',next_step='none';
  if (!gatewayConnected&&!gatewayRequiresSubscription) {stage='gateway';reason='gateway_disconnected';next_step='check_gateway';}
  else if (!callbackHosts.length) {stage='callback_policy';reason='callback_hosts_empty';next_step='approve_callback_hostname';}
  else if (subscription.state === 'active' && !callbackAllowed) {stage='callback_policy';reason='callback_host_not_allowlisted';next_step='approve_callback_hostname';}
  else if (subscription.state !== 'active') {
    stage='subscription';
    if (subscription.state === 'expired') {reason='subscription_expired';next_step='renew_in_original_dot';}
    else if (subscription.state === 'disabled') {reason='subscription_disabled';next_step='subscribe_in_original_dot';}
    else if (subscription.state === 'unknown') {reason='subscription_unknown';next_step='inspect_subscription_diagnostics';}
    else if (diagnostics.length && diagnostics.at(-1).reason !== 'subscribed') {reason='subscription_failed';next_step='inspect_subscription_diagnostics';}
    else {reason='subscription_missing';next_step='subscribe_in_original_dot';}
  }
  else if (!gatewayConnected) {stage='gateway';reason='gateway_disconnected';next_step='check_gateway';}
  return {stage,reason,next_step,callback_hosts_count:callbackHosts.length,diagnostic_history:diagnostics.length ? 'available' : 'unavailable',callback_hosts_configured:callbackHosts.length>0,callback_setting_name:settingName,
    ...(typeof wrongSettingPresent==='boolean'?{wrong_callback_setting_present:wrongSettingPresent}:{}),
    ...(typeof legacyAliasPresent==='boolean'&&settingName==='CALLBACK_HOSTS'?{legacy_callback_alias_present:legacyAliasPresent}:{})};
}

const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export function runtimeStatusProperties() {
  const bool={type:'boolean'},count={type:'integer',minimum:0};
  const diagnostic=schema({at:{type:'string',format:'date-time'},stage:{type:'string',enum:diagnosticStages},code:{type:['integer','null']},reason:{type:'string',enum:diagnosticReasons},hostname:{type:['string','null'],maxLength:253}});
  return {
    binding_ready:bool,gateway_connected:bool,subscription_active:bool,
    subscription_diagnostics:{type:'array',maxItems:5,items:diagnostic},
    subscription_status:schema({state:{type:'string',enum:['none','active','expired','disabled','unknown']},expires_at:{type:['string','null'],format:'date-time'},remaining_seconds:{type:['integer','null'],minimum:0},renewal_owner:{type:'string',const:'host'},diagnostics_available:bool}),
    connection_status:schema({stage:{type:'string',enum:connectionStages},reason:{type:'string',enum:connectionReasons},next_step:{type:'string',enum:connectionNextSteps},callback_hosts_count:{type:'integer',minimum:0,maximum:16},diagnostic_history:{type:'string',enum:['available','unavailable']},callback_hosts_configured:bool,legacy_callback_alias_present:bool,callback_setting_name:{type:'string',enum:['CALLBACK_HOSTS','MCP_CALLBACK_ALLOWED_HOSTS']},wrong_callback_setting_present:bool},['stage','reason','next_step','callback_hosts_count','diagnostic_history']),
    reply_work:schema({pending:count,processing:count,uncertain:count}),
    media_limits:schema({read_bytes:{type:'integer',minimum:0,maximum:MAX_MEDIA_BYTES},reply_bytes:{type:'integer',minimum:0,maximum:MAX_MEDIA_BYTES},mcp_body_bytes:{type:'integer',const:MEDIA_RPC_LIMIT},tunnel_envelope_bytes:{type:'integer',const:TUNNEL_ENVELOPE_BYTES}}),
    media_readiness:schema({reply_publisher_configured:bool,reply_publisher_required:bool},['reply_publisher_configured']),
    reply_capabilities:schema({max_text_chars:{type:'integer',minimum:1,maximum:20000},native_text_chars:{type:'integer',minimum:1,maximum:20000},long_reply_mode:{type:'string',enum:['file','chunks','none']}}),
    experience_capabilities:schema({feedback_enabled:bool,typing:bool,reactions:bool,progressive_replies:bool,recent_context:bool,management_commands:bool,configured_groups:{type:'integer',minimum:0,maximum:50},hosted_dot_controls:bool})
  };
}
export const RUNTIME_STATUS_FIELDS=Object.freeze(Object.keys(runtimeStatusProperties()));

function validateStatus(value,s) {
  if(value===null&&Array.isArray(s.type)&&s.type.includes('null'))return;
  const type=Array.isArray(s.type)?s.type.find(t=>t!=='null'):s.type;
  if(type==='object'){object(value,Object.keys(s.properties),s.required??[]);for(const[k,v]of Object.entries(value))validateStatus(v,s.properties[k]);return;}
  if(type==='array'){if(!Array.isArray(value)||value.length>(s.maxItems??100))throw Error('Invalid status array');for(const v of value)validateStatus(v,s.items);return;}
  if(type==='integer'){if(!Number.isSafeInteger(value)||value<(s.minimum??Number.MIN_SAFE_INTEGER)||value>(s.maximum??Number.MAX_SAFE_INTEGER))throw Error('Invalid status count');}
  else if(typeof value!==type)throw Error('Invalid status type');
  if(type==='string'){boundedString(value,s.maxLength??2048,{empty:true,multiline:false});if(s.format==='date-time'&&!Number.isFinite(Date.parse(value)))throw Error('Invalid status timestamp');}
  if((s.enum&&!s.enum.includes(value))||(s.const!==undefined&&value!==s.const))throw Error('Invalid status constant');
}
export function projectRuntimeStatus(source) {
  const properties=runtimeStatusProperties(),result={};
  for(const key of RUNTIME_STATUS_FIELDS)if(Object.hasOwn(source,key)){validateStatus(source[key],properties[key]);result[key]=structuredClone(source[key]);}
  if(result.subscription_diagnostics&&subscriptionDiagnostics(result.subscription_diagnostics).length!==result.subscription_diagnostics.length)throw Error('Unsafe subscription diagnostic');
  if(result.subscription_active===true&&result.subscription_status&&result.subscription_status.state!=='active')throw Error('Inconsistent subscription status');
  const connection=result.connection_status;
  if(connection?.callback_hosts_configured!==undefined&&connection.callback_hosts_configured!==(connection.callback_hosts_count>0))throw Error('Inconsistent callback setting status');
  return result;
}

export function optionalStatusSchemaMatch(actual,expected,sameSchema) {
  if(sameSchema(actual,expected))return true;
  const align=(a,e)=>{
    if(a?.type!=='object'||e?.type!=='object'||!a.properties||!e.properties)return e;
    if(Object.keys(a.properties).some(k=>!Object.hasOwn(e.properties,k))||(e.required??[]).some(k=>!Object.hasOwn(a.properties,k)))throw Error('Unknown or missing status property');
    return {...e,properties:Object.fromEntries(Object.entries(e.properties).filter(([k])=>Object.hasOwn(a.properties,k)).map(([k,s])=>[k,align(a.properties[k],s)]))};
  };
  try{return sameSchema(actual,align(actual,expected));}catch{return false;}
}

export async function trackSubscriptionAttempt(params,operation,{clock=Date.now,load=()=>[],save=()=>{}}={}) {
  const diagnostic={at:new Date(clock()).toISOString(),stage:'validate',code:null,reason:'invalid_request',hostname:null};
  try{diagnostic.hostname=callbackUrl(params?.delivery?.url).hostname;}catch{/* Unvalidated input is never retained. */}
  try{const result=await operation(diagnostic);diagnostic.stage='complete';diagnostic.reason='subscribed';return result;}
  catch(error){
    diagnostic.code=Number.isInteger(error?.code)&&error.code>=-32768&&error.code<=-32000?error.code:-32603;
    diagnostic.reason=error?.data?.reason==='callback_policy_required'||error?.data?.callback_policy==='blocked'?'callback_policy_required':
      diagnostic.code===-32013?'subscription_conflict':diagnostic.code===-32012&&diagnostic.stage!=='validate'?'subscription_cancelled':
      diagnostic.stage==='transport'?'transport_unavailable':diagnostic.stage==='challenge'?(error?.data?.reason==='timeout'||error?.code==='ETIMEDOUT'||error?.name==='TimeoutError'?'timeout':'challenge_failed'):
      diagnostic.stage==='persist'?'storage_unavailable':'invalid_request';
    throw error;
  }finally{try{save(subscriptionDiagnostics([...subscriptionDiagnostics(load()),diagnostic]).slice(-5));}catch{/* Diagnostic storage cannot change the subscription result. */}}
}

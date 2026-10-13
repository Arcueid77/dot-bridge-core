// Explicit continuous owner callback policy. Authentication, durable jobs and
// immutable message deadlines remain in the existing bridge Store/authorization.
// The existing proxy resolves the hostname; its final address is NOT attested.
import {performance} from 'node:perf_hooks';
import {configuredProxy,bypassMatches,validateCallbackUrl,CallbackTransportError} from './transport.js';
import {projectCallbackTransportStatus} from './status.js';
import {makeNodeProxyConnection} from './candidate/node-proxy-connection.js';
const entries=new WeakMap(),headerNames=['content-type','webhook-id','webhook-timestamp','webhook-signature','x-mcp-subscription-id'];
const fail=code=>new CallbackTransportError(code);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const text=value=>typeof value==='string'&&value.length<=2000&&!!value.trim()&&Buffer.byteLength(value)<=8000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&!/\p{Surrogate}/u.test(value);
const fingerprint=proxy=>JSON.stringify(proxy?{url:proxy.url.href,authorization:proxy.authorization??null,noProxy:proxy.noProxy}:null);
const blocked=(reason,configured=true)=>projectCallbackTransportStatus({ready:false,mode:'blocked',reason,proxy_configured:configured,destination_binding:'unverified',network_checked:false});
export function ownerScopedProxyStatus(sender,proxyEnv){return entries.get(sender)?.status(proxyEnv)??null;}
export function makeOwnerScopedProxyTransport({channel,proxyEnv=process.env,connect,now=Date.now,maxTrackedEvents=10000}={}){
 if(!['qq','lark'].includes(channel)||typeof now!=='function'||(connect!==undefined&&typeof connect!=='function')||!Number.isSafeInteger(maxTrackedEvents)||maxTrackedEvents<1||maxTrackedEvents>100000)throw fail('invalid_options');
 if(!Number.isSafeInteger(now()))throw fail('invalid_options');
 const proxy=configuredProxy(proxyEnv);if(!proxy||proxy.authorization)throw fail('proxy_unsupported');
 const initial=fingerprint(proxy),connection=connect??makeNodeProxyConnection(),scope=new AbortController(),attempted=new Map();
 let closed=false,busy=false;
 const status=env=>{
  let selected;try{selected=configuredProxy(env??proxyEnv);if(!selected||selected.authorization||fingerprint(selected)!==initial||fingerprint(configuredProxy(proxyEnv))!==initial)return blocked('proxy_unsupported',!!selected);}catch{return blocked('proxy_unsupported',!!selected);}
  return closed?blocked('scope_closed'):projectCallbackTransportStatus({ready:true,mode:'owner_scoped_proxy',reason:'none',proxy_configured:true,destination_binding:'unverified',network_checked:false});
 };
 const active=()=>{if(closed||scope.signal.aborted)throw fail('aborted');if(!status().ready)throw fail('proxy_unsupported');};
 const send=async(raw,{method='POST',headers,body,hosts,beforeConnect,signal}={})=>{
  active();if(busy)throw fail('request_busy');
  if(method!=='POST'||typeof beforeConnect!=='function'||(signal!==undefined&&!(signal instanceof AbortSignal))||!Buffer.isBuffer(body)||body.length>8192)throw fail('invalid_input');
  const url=validateCallbackUrl(raw);
  if(!Array.isArray(hosts)||!hosts.length||hosts.length>64||hosts.some(host=>typeof host!=='string')||!hosts.includes(url.hostname))throw fail('host_not_allowed');
  if(bypassMatches(proxy,url.hostname))throw fail('proxy_unsupported');
  if(!headers||typeof headers!=='object'||Array.isArray(headers))throw fail('invalid_input');
  const outgoing=Object.create(null);
  for(const [name,value]of Object.entries(headers)){const key=name.toLowerCase();if(!headerNames.includes(key)||Object.hasOwn(outgoing,key)||typeof value!=='string'||value.length>1024||/[\x00-\x1f\x7f]/.test(value))throw fail('invalid_input');outgoing[key]=value;}
  const subscriptionId=outgoing['x-mcp-subscription-id'];
  if(!exact(outgoing,headerNames)||outgoing['content-type']!=='application/json'||!/^sub_[a-f0-9]{64}$/.test(subscriptionId)||!/^\d{1,13}$/.test(outgoing['webhook-timestamp'])||!/^v1,[A-Za-z0-9+/]{43}=(?: v1,[A-Za-z0-9+/]{43}=)?$/.test(outgoing['webhook-signature']))throw fail('invalid_input');
  const payload=Buffer.from(body);let value;try{value=JSON.parse(payload.toString('utf8'));}catch{throw fail('invalid_input');}
  if(!Buffer.from(JSON.stringify(value)).equals(payload))throw fail('invalid_input');
  const challenge=value?.type==='verification';let replyDeadline=Infinity;
  if(challenge){if(!exact(value,['type','challenge'])||!/^[A-Za-z0-9_-]{43}$/.test(value.challenge)||!/^verify_[a-f0-9]{32}$/.test(outgoing['webhook-id']))throw fail('invalid_input');}
  else{
   if(!exact(value,['eventId','name','timestamp','data','cursor'])||value.name!==`${channel}.message.created`||value.cursor!==null||!/^evt_[a-f0-9]{64}$/.test(value.eventId)||outgoing['webhook-id']!==value.eventId||!iso(value.timestamp)||!exact(value.data,['message_id','conversation','text','reply_deadline'])||typeof value.data.message_id!=='string'||!value.data.message_id.length||value.data.message_id.length>256||/[\x00-\x1f\x7f]/.test(value.data.message_id)||value.data.conversation!=='owner'||!text(value.data.text)||!iso(value.data.reply_deadline))throw fail('invalid_input');
   replyDeadline=Date.parse(value.data.reply_deadline);if(replyDeadline<=now())throw fail('invalid_input');
  }
  const key=challenge?null:`${subscriptionId}:${value.eventId}`;
  for(const [id,entry]of attempted)if(entry.expires<=now())attempted.delete(id);
  if(key&&attempted.has(key))throw fail('event_replayed');
  if(key&&attempted.size>=maxTrackedEvents)throw fail('capacity_exceeded');
  busy=true;let timer,timedOut=false,startedAttempt=false,removeAbort=()=>{},grantExpires=Infinity;
  const deadline=new AbortController(),activeSignal=AbortSignal.any([scope.signal,deadline.signal,...(signal?[signal]:[])]),began=now(),monoBegan=performance.now();
  const current=()=>{active();const time=now();if(!Number.isSafeInteger(time)||time<began||time>=grantExpires||time>=replyDeadline||activeSignal.aborted)throw fail(timedOut?'timeout':'aborted');if(bypassMatches(proxy,url.hostname))throw fail('proxy_unsupported');};
  const gate=operation=>{
   current();let authority;try{authority=beforeConnect();}catch{throw fail('gate_failed');}
   const perform=grant=>{
    if(!exact(grant,['principal','url','subscription_id','expires','verified'])||grant.principal!=='tunnel-owner:dot-bridge'||grant.subscription_id!==subscriptionId||validateCallbackUrl(grant.url).href!==url.href||!Number.isSafeInteger(grant.expires)||grant.expires<=now()||typeof grant.verified!=='boolean'||(!challenge&&!grant.verified))throw fail('gate_failed');
    grantExpires=grant.expires;current();arm();return operation?.();
   };
   return authority&&typeof authority.then==='function'?Promise.resolve(authority).then(perform,()=>{throw fail('gate_failed');}):perform(authority);
  };
  const remaining=()=>Math.min(10000-(now()-began),10000-(performance.now()-monoBegan),grantExpires-now(),replyDeadline-now());
  const arm=()=>{const ms=remaining();if(ms<=0)throw fail('aborted');clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;deadline.abort();},ms);};
  try{
   arm();const interrupted=new Promise((_,reject)=>{const abort=()=>reject(fail(timedOut?'timeout':'aborted'));removeAbort=()=>activeSignal.removeEventListener('abort',abort);if(activeSignal.aborted)abort();else activeSignal.addEventListener('abort',abort,{once:true});});interrupted.catch(()=>{});
   await Promise.race([Promise.resolve(gate()),interrupted]);current();arm();
   if(key)attempted.set(key,{expires:replyDeadline});startedAttempt=true;
   const pending=Promise.resolve(connection(url,proxy.url,{method:'POST',headers:{...outgoing,host:url.hostname,'content-length':String(payload.length),accept:'application/json','accept-encoding':'identity'},body:payload,proxy:{url:proxy.url.href},beforeConnect:gate,signal:activeSignal,timeoutMs:Math.max(1,Math.floor(remaining())),maxBytes:8192}));pending.catch(()=>{});
   const response=await Promise.race([pending,interrupted]);current();await Promise.race([Promise.resolve(gate()),interrupted]);current();
   if(!response||!Number.isInteger(response.status)||response.status<200||response.status>599||!Buffer.isBuffer(response.body)||response.body.length>8192)throw fail('invalid_response');
   if(response.status>=300&&response.status<400)throw fail('redirect_rejected');
   if(!challenge&&(response.status<200||response.status>=300)&&response.status!==410)throw fail('status_rejected');
   if(challenge){let echo;try{echo=JSON.parse(response.body.toString('utf8'));}catch{}if(response.status<200||response.status>=300||echo?.challenge!==value.challenge)throw fail('invalid_response');}
   return response;
  }catch(error){
   if(!challenge&&startedAttempt)throw fail('delivery_uncertain');
   throw error instanceof CallbackTransportError?error:fail('connection_failed');
  }finally{clearTimeout(timer);removeAbort();deadline.abort();payload.fill(0);busy=false;}
 };
 Object.defineProperties(send,{preflight:{value:()=>status()},close:{value:()=>{closed=true;scope.abort();}},state:{value:()=>Object.freeze({closed,in_flight:busy,tracked_events:attempted.size,final_address_binding:'unverified'})}});
 entries.set(send,{status});return send;
}

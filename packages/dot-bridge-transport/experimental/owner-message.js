// Explicit owner single-message experiment. No default entry selects it.
// Subscription authentication and owner/provider identity remain upstream.
// The selected proxy resolves the bound hostname; final IP is NOT attested.
import {performance} from 'node:perf_hooks';
import {configuredProxy,bypassMatches,validateCallbackUrl,CallbackTransportError} from '../transport.js';
import {projectCallbackTransportStatus} from '../status.js';
import {makeNodeProxyConnection} from '../candidate/node-proxy-connection.js';
const entries=new WeakMap();
const fail=code=>new CallbackTransportError(code);
const names=['content-type','webhook-id','webhook-timestamp','webhook-signature','x-mcp-subscription-id'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
// Same ordinary-text ceiling as the bridge: content is data, never authority.
const ordinaryOwnerText=value=>typeof value==='string'&&value.length<=2000&&!!value.trim()&&Buffer.byteLength(value)<=8000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&!/\p{Surrogate}/u.test(value);
const fingerprint=proxy=>JSON.stringify(proxy?{url:proxy.url.href,authorization:proxy.authorization??null,noProxy:proxy.noProxy}:null);
const blocked=(reason,configured=true)=>projectCallbackTransportStatus({ready:false,mode:'blocked',reason,proxy_configured:configured,destination_binding:'unverified',network_checked:false});
const activeStatus=()=>projectCallbackTransportStatus({ready:true,mode:'owner_single_message_proxy',reason:'none',proxy_configured:true,destination_binding:'unverified',network_checked:false});

export function ownerMessageExperimentStatus(sender,proxyEnv){
 const entry=entries.get(sender);return entry?entry.status(proxyEnv):null;
}
export function makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment=false,channel,expectedText,acceptAnyOwnerText=false,waitForOwner=false,deadlineMs,restoredState,proxyEnv=process.env,connect,now=Date.now}={}){
 if(approvedOwnerMessageExperiment!==true||!['qq','lark'].includes(channel)||typeof acceptAnyOwnerText!=='boolean'||typeof waitForOwner!=='boolean'||(!acceptAnyOwnerText&&(typeof expectedText!=='string'||!expectedText.trim()||Buffer.byteLength(expectedText)>1024||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(expectedText)))||typeof now!=='function'||(connect!==undefined&&typeof connect!=='function'))throw fail('invalid_options');
 const started=now(),monoStarted=performance.now();
 if(!Number.isSafeInteger(started)||(waitForOwner?deadlineMs!==undefined:(!Number.isSafeInteger(deadlineMs)||deadlineMs<=started||deadlineMs-started>900000)))throw fail('invalid_options');
 let effectiveDeadline=waitForOwner?null:deadlineMs;
 const originalProxy=configuredProxy(proxyEnv);if(!originalProxy||originalProxy.authorization)throw fail('proxy_unsupported');
 const initial=fingerprint(originalProxy),scopeController=new AbortController();
 const connection=connect??makeNodeProxyConnection();
 let closed=false,busy=false,bound=null,boundSubscription=null,challengeAttempted=false,challengeVerified=false,eventAttempted=false,eventAccepted=false;
 // Trusted caller-owned persistence only. This imports an already verified
 // grant; it neither reads storage nor proves the provenance of that grant.
 if(restoredState!==undefined){
  if(!waitForOwner||!exact(restoredState,['url','subscription_id','valid_until','challenge_verified','event_attempted','event_accepted','closed'])||restoredState.challenge_verified!==true||typeof restoredState.subscription_id!=='string'||!/^sub_[a-f0-9]{64}$/.test(restoredState.subscription_id)||!Number.isSafeInteger(restoredState.valid_until)||restoredState.valid_until<=0||!Number.isSafeInteger(restoredState.valid_until-started)||typeof restoredState.event_attempted!=='boolean'||typeof restoredState.event_accepted!=='boolean'||typeof restoredState.closed!=='boolean'||(restoredState.event_accepted&&!restoredState.event_attempted))throw fail('invalid_options');
  const restoredUrl=validateCallbackUrl(restoredState.url);
  if(bypassMatches(originalProxy,restoredUrl.hostname))throw fail('proxy_unsupported');
  bound=restoredUrl.href;boundSubscription=restoredState.subscription_id;effectiveDeadline=restoredState.valid_until;
  challengeAttempted=true;challengeVerified=true;eventAttempted=restoredState.event_attempted;eventAccepted=restoredState.event_accepted;
  closed=restoredState.closed||(eventAttempted&&!eventAccepted);if(closed)scopeController.abort();
 }

 const remainingMs=()=>{const time=now();return effectiveDeadline===null||!Number.isSafeInteger(time)||time<started?-1:Math.min(effectiveDeadline-time,effectiveDeadline-started-(performance.now()-monoStarted));};
 const expired=()=>effectiveDeadline!==null&&remainingMs()<=0;
 // The authenticated session owns renewal authority. This method does not
 // authenticate a principal or relax the bound URL/subscription identity.
 const renewLease=validUntil=>{
  const time=now();
  if(!waitForOwner||closed||busy||eventAttempted||(challengeAttempted&&!challengeVerified)||scopeController.signal.aborted||!Number.isSafeInteger(time)||time<started||!Number.isSafeInteger(validUntil)||!Number.isSafeInteger(validUntil-time)||!Number.isSafeInteger(validUntil-started)||validUntil<=time)throw fail('invalid_options');
  effectiveDeadline=validUntil;
 };
 const status=env=>{
  let selected;
  try{selected=configuredProxy(env===undefined?proxyEnv:env);if(!selected||selected.authorization||fingerprint(selected)!==initial||fingerprint(configuredProxy(proxyEnv))!==initial)return blocked('proxy_unsupported',!!selected);}
  catch{return blocked('proxy_unsupported',!!selected);}
  if(closed)return blocked('scope_closed');
  if(effectiveDeadline===null)return blocked('awaiting_subscription');
  return expired()?blocked('scope_expired'):activeStatus();
 };
 const current=()=>{if(closed||effectiveDeadline===null||expired()||scopeController.signal.aborted)throw fail('aborted');if(!status().ready)throw fail('proxy_unsupported');};
 const send=async(raw,{method='POST',headers,body,hosts,beforeConnect,signal}={})=>{
  current();if(busy||method!=='POST'||typeof beforeConnect!=='function'||(signal!==undefined&&!(signal instanceof AbortSignal))||!Buffer.isBuffer(body)||body.length>8192)throw fail('invalid_input');
  const url=validateCallbackUrl(raw);
  if(bound!==null&&bound!==url.href)throw fail('host_not_allowed');
  if(hosts!==undefined&&(!Array.isArray(hosts)||hosts.length>64||hosts.some(x=>typeof x!=='string')||(hosts.length&&!hosts.includes(url.hostname))))throw fail('host_not_allowed');
  if(bypassMatches(originalProxy,url.hostname))throw fail('proxy_unsupported');
  if(!headers||typeof headers!=='object'||Array.isArray(headers))throw fail('invalid_input');
  const outgoing=Object.create(null);
  for(const [name,value]of Object.entries(headers)){const key=name.toLowerCase();if(!names.includes(key)||Object.hasOwn(outgoing,key)||typeof value!=='string'||value.length>1024||/[\x00-\x1f\x7f]/.test(value))throw fail('invalid_input');outgoing[key]=value;}
  if(!exact(outgoing,names)||outgoing['content-type']!=='application/json'||!/^sub_[a-f0-9]{64}$/.test(outgoing['x-mcp-subscription-id'])||!/^\d{1,13}$/.test(outgoing['webhook-timestamp'])||!/^v1,[A-Za-z0-9+/]{43}=(?: v1,[A-Za-z0-9+/]{43}=)?$/.test(outgoing['webhook-signature']))throw fail('invalid_input');
  const payload=Buffer.from(body);let value;try{value=JSON.parse(payload.toString('utf8'));}catch{throw fail('invalid_input');}
  if(!Buffer.from(JSON.stringify(value)).equals(payload))throw fail('invalid_input');
  const challenge=value?.type==='verification';
  if(challenge){
   if(challengeAttempted||eventAttempted||!exact(value,['type','challenge'])||!/^[A-Za-z0-9_-]{43}$/.test(value.challenge)||!/^verify_[a-f0-9]{32}$/.test(outgoing['webhook-id']))throw fail('invalid_input');
  }else{
   if(!challengeVerified||eventAttempted||!exact(value,['eventId','name','timestamp','data','cursor'])||value.name!==`${channel}.message.created`||value.cursor!==null||!/^evt_[a-f0-9]{64}$/.test(value.eventId)||outgoing['webhook-id']!==value.eventId||!iso(value.timestamp)||!exact(value.data,['message_id','conversation','text','reply_deadline'])||typeof value.data.message_id!=='string'||!value.data.message_id.length||value.data.message_id.length>256||/[\x00-\x1f\x7f]/.test(value.data.message_id)||value.data.conversation!=='owner'||(acceptAnyOwnerText?!ordinaryOwnerText(value.data.text):value.data.text!==expectedText)||!iso(value.data.reply_deadline)||Date.parse(value.data.reply_deadline)<=now()||boundSubscription!==outgoing['x-mcp-subscription-id'])throw fail('invalid_input');
  }
  busy=true;let timer,timedOut=false,removeAbort=()=>{};
  const deadlineController=new AbortController();
  const signals=[scopeController.signal,deadlineController.signal,...(signal?[signal]:[])];const activeSignal=AbortSignal.any(signals);
  const active=()=>{current();if(activeSignal.aborted)throw fail(timedOut?'timeout':'aborted');if(bypassMatches(originalProxy,url.hostname))throw fail('proxy_unsupported');};
  const gate=operation=>{active();let approval;try{approval=beforeConnect();}catch{throw fail('gate_failed');}const perform=()=>{active();return operation?.();};return approval&&typeof approval.then==='function'?Promise.resolve(approval).then(perform,()=>{throw fail('gate_failed');}):perform();};
  try{
   const requestStarted=now(),requestMonoStarted=performance.now();let remaining;const armTimeout=()=>{remaining=Math.min(10000-(now()-requestStarted),10000-(performance.now()-requestMonoStarted),remainingMs());if(remaining<=0)throw fail('aborted');clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;deadlineController.abort();},remaining);};
   armTimeout();
   const interrupted=new Promise((_,reject)=>{const abort=()=>reject(fail(timedOut?'timeout':'aborted'));removeAbort=()=>activeSignal.removeEventListener('abort',abort);if(activeSignal.aborted)abort();else activeSignal.addEventListener('abort',abort,{once:true});});interrupted.catch(()=>{});
   await Promise.race([Promise.resolve(gate()),interrupted]);active();bound??=url.href;boundSubscription??=outgoing['x-mcp-subscription-id'];if(challenge)challengeAttempted=true;else{eventAttempted=true;if(waitForOwner){effectiveDeadline=Math.min(effectiveDeadline,Date.parse(value.data.reply_deadline));armTimeout();}}
   const pending=Promise.resolve(connection(url,originalProxy.url,{method:'POST',headers:{...outgoing,host:url.hostname,'content-length':String(payload.length),accept:'application/json','accept-encoding':'identity'},body:payload,proxy:{url:originalProxy.url.href},beforeConnect:gate,signal:activeSignal,timeoutMs:Math.max(1,Math.floor(remaining)),maxBytes:8192}));pending.catch(()=>{});
   const response=await Promise.race([pending,interrupted]);active();await Promise.race([Promise.resolve(gate()),interrupted]);active();
   if(!response||!Number.isInteger(response.status)||response.status<200||response.status>599||!Buffer.isBuffer(response.body)||response.body.length>8192)throw fail('invalid_response');
   if(response.status>=300&&response.status<400)throw fail('redirect_rejected');
   if(challenge){let echoed;try{echoed=JSON.parse(response.body.toString('utf8'));}catch{}challengeVerified=response.status>=200&&response.status<300&&echoed?.challenge===value.challenge;}
   else eventAccepted=response.status>=200&&response.status<300;
   return response;
  }catch(error){throw error instanceof CallbackTransportError?error:fail('connection_failed');}
  finally{clearTimeout(timer);removeAbort();deadlineController.abort();busy=false;}
 };
 Object.defineProperties(send,{
  preflight:{value:()=>status()},
  renewLease:{value:renewLease},
  state:{value:()=>Object.freeze({channel,deadline_ms:effectiveDeadline,closed,expired:expired(),challenge_attempted:challengeAttempted,challenge_verified:challengeVerified,event_attempted:eventAttempted,event_accepted:eventAccepted,final_address_binding:'unverified'})},
  close:{value:()=>{closed=true;scopeController.abort();}},
 });
 entries.set(send,{status});return send;
}

// Shared callback-only transport: no provider clients, file credentials, proxy
// tunneling implementation, redirects, logging, persistence or automatic retries.
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHmac} from 'node:crypto';
import {projectCallbackTransportStatus} from './status.js';
const MAX_BYTES=8192,MAX_BODY_BYTES=262144;
export const TRANSPORT_ERROR_CODES=Object.freeze(['invalid_url','host_not_allowed','invalid_key','invalid_input','invalid_options','blocked_address','dns_failed','gate_failed','aborted','timeout','connection_failed','tls_failed','invalid_response','response_too_large','redirect_rejected','status_rejected','proxy_unsupported','proxy_policy_unverified','adapter_invalid','adapter_failed','request_busy','event_replayed','capacity_exceeded','delivery_uncertain']);
export class CallbackTransportError extends Error {
  constructor(code){super('Callback transport rejected or failed');this.name='CallbackTransportError';this.code=TRANSPORT_ERROR_CODES.includes(code)?code:'connection_failed';this.reason=this.code;}
}
const error=code=>new CallbackTransportError(code);
const hostnameIsDns=host=>typeof host==='string'&&host.length<=253&&!isIP(host)&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
export function validateCallbackUrl(raw){
  if(typeof raw!=='string'||!raw.length||raw.length>2048||/[\x00-\x20\x7f\\#]/.test(raw))throw error('invalid_url');
  const authority=/^https:\/\/([^/?#]+)/i.exec(raw)?.[1];if(!authority||authority.includes('@'))throw error('invalid_url');
  let url;try{url=new URL(raw);}catch{throw error('invalid_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!hostnameIsDns(url.hostname)||(authority.includes(':')&&!authority.endsWith(':443')))throw error('invalid_url');return url;
}
export function publicAddress(address){
  if(typeof address!=='string'||address.includes('%'))return false;
  if(isIP(address)===4){const[a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&((b===0&&(c===0||c===2))||b===168||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));}
  if(isIP(address)!==6||address.includes('.'))return false;const[left,right]=address.toLowerCase().split('::'),start=left?left.split(':'):[],end=right?right.split(':'):[];
  const words=right===undefined?start:[...start,...Array(8-start.length-end.length).fill('0'),...end];const[first,second]=words.map(x=>parseInt(x,16));
  return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&(second<0x200||second===0xdb8))&&!(first===0x3fff&&second<0x1000);
}
export function decodeWebhookKey(secret){
  if(typeof secret!=='string'||secret.length>100||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw error('invalid_key');
  const encoded=secret.slice(6),key=Buffer.from(encoded,'base64'),canonical=key.toString('base64');
  if(key.length<24||key.length>64||(canonical!==encoded&&canonical.replace(/=+$/,'')!==encoded)){key.fill(0);throw error('invalid_key');}return key;
}
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);
function bodyBytes(body,limit=MAX_BODY_BYTES){if(!Buffer.isBuffer(body)&&typeof body!=='string')throw error('invalid_input');const bytes=Buffer.from(body);if(bytes.length>limit)throw error('invalid_input');return bytes;}
export function signedHeaders({id,key}={},eventId,body,nowMs){
  if(!validId(id)||!validId(eventId)||!Number.isSafeInteger(nowMs)||nowMs<0)throw error('invalid_input');const bytes=bodyBytes(body);if(!Buffer.isBuffer(key))throw error('invalid_key');const decoded=Buffer.from(key);
  try{if(decoded.length<24||decoded.length>64)throw error('invalid_key');const timestamp=String(Math.floor(nowMs/1000));return {'content-type':'application/json','webhook-id':eventId,'webhook-timestamp':timestamp,'webhook-signature':`v1,${createHmac('sha256',decoded).update(`${eventId}.${timestamp}.`).update(bytes).digest('base64')}`,'x-mcp-subscription-id':id};}finally{decoded.fill(0);}
}
const PROXY_NAMES=['https_proxy','HTTPS_PROXY','http_proxy','HTTP_PROXY','all_proxy','ALL_PROXY'];
const present=value=>value!==undefined&&value!=='';
const selected=(env,lower,upper)=>present(env[lower])?env[lower]:env[upper];
function ipNumber(address){
  if(typeof address!=='string'||address.includes('%'))throw error('proxy_unsupported');const family=isIP(address);
  if(family===4)return {family,bits:32,value:address.split('.').reduce((value,byte)=>(value<<8n)|BigInt(byte),0n)};
  if(family!==6)throw error('proxy_unsupported');let text=address.toLowerCase();
  if(text.includes('.')){const index=text.lastIndexOf(':'),b=text.slice(index+1).split('.').map(Number);text=text.slice(0,index+1)+((b[0]<<8)|b[1]).toString(16)+':'+((b[2]<<8)|b[3]).toString(16);}
  const[left,right]=text.split('::'),start=left?left.split(':'):[],end=right?right.split(':'):[],words=right===undefined?start:[...start,...Array(8-start.length-end.length).fill('0'),...end];
  return {family,bits:128,value:words.reduce((value,word)=>(value<<16n)|BigInt('0x'+word),0n)};
}
function noProxyRules(env){
  const rules=[],value=selected(env,'no_proxy','NO_PROXY');if(!present(value))return rules;if(typeof value!=='string'||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw error('proxy_unsupported');
  for(const entry of value.split(',')){let raw=entry.trim().toLowerCase();if(!raw)continue;if(rules.length>=64)throw error('proxy_unsupported');if(raw==='*'){rules.push({kind:'all'});continue;}
    if(raw.includes('/')){const p=raw.split('/');if(p.length!==2||!/^(?:0|[1-9][0-9]{0,2})$/.test(p[1]))throw error('proxy_unsupported');const a=ipNumber(p[0]),prefix=Number(p[1]);if(prefix>a.bits)throw error('proxy_unsupported');rules.push({kind:'cidr',family:a.family,prefix,network:(a.value>>BigInt(a.bits-prefix)).toString(16)});continue;}
    if(raw.startsWith('[')){const m=/^\[([^\]]+)\](?::443)?$/.exec(raw);if(!m||isIP(m[1])!==6||m[1].includes('%'))throw error('proxy_unsupported');rules.push({kind:'ip',host:new URL(`https://[${m[1]}]/`).hostname});continue;}
    if(isIP(raw)===6){if(raw.includes('%'))throw error('proxy_unsupported');rules.push({kind:'ip',host:new URL(`https://[${raw}]/`).hostname});continue;}
    if(raw.includes(':')){if(!raw.endsWith(':443')||raw.slice(0,-4).includes(':'))throw error('proxy_unsupported');raw=raw.slice(0,-4);}
    if(isIP(raw)===4){rules.push({kind:'ip',host:raw});continue;}const suffix=raw.startsWith('*.')||raw.startsWith('.'),host=raw.replace(/^\*?\./,'');
    if(!host||host.length>253||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw error('proxy_unsupported');rules.push({kind:suffix?'suffix':'host',host});
  }return rules;
}
export function configuredProxy(env){
  if(!env||typeof env!=='object')throw error('proxy_unsupported');const raw=selected(env,'https_proxy','HTTPS_PROXY');
  if(!present(raw)){if(PROXY_NAMES.some(name=>present(env[name])))throw error('proxy_unsupported');return null;}
  if(typeof raw!=='string'||raw.length>2048||/[\x00-\x20\x7f\\#]/.test(raw))throw error('proxy_unsupported');let url;try{url=new URL(raw);}catch{throw error('proxy_unsupported');}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.hash||url.search||url.pathname!=='/')throw error('proxy_unsupported');let authorization;
  if(url.username||url.password){let u,p;try{u=decodeURIComponent(url.username);p=decodeURIComponent(url.password);}catch{throw error('proxy_unsupported');}if(!u||u.includes(':')||/[\x00-\x1f\x7f]/.test(u+p))throw error('proxy_unsupported');authorization=`Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;url.username='';url.password='';}
  return {url,authorization,noProxy:noProxyRules(env)};
}
export function bypassMatches(proxy,host,addresses=[]){return !!proxy&&proxy.noProxy.some(rule=>rule.kind==='all'||(rule.kind==='host'&&rule.host===host)||(rule.kind==='suffix'&&(rule.host===host||host.endsWith('.'+rule.host)))||(rule.kind==='ip'&&addresses.some(a=>(isIP(a)===6?new URL(`https://[${a}]/`).hostname:a)===rule.host))||(rule.kind==='cidr'&&addresses.some(a=>{const p=ipNumber(a);return p.family===rule.family&&(p.value>>BigInt(p.bits-rule.prefix)).toString(16)===rule.network;})));}
function adapterValid(adapter){return adapter===undefined||adapter===null||(!!adapter&&typeof adapter==='object'&&!Array.isArray(adapter)&&Object.keys(adapter).length===1&&Object.hasOwn(adapter,'send')&&typeof adapter.send==='function');}
function blocked(reason,configured){return projectCallbackTransportStatus({ready:false,mode:'blocked',reason,proxy_configured:configured,destination_binding:'unverified',network_checked:false});}
export function preflightCallbackTransport(options={}){
  let configured=false;try{if(!options||typeof options!=='object'||Array.isArray(options))throw error('invalid_options');const env=options.proxyEnv===undefined?process.env:options.proxyEnv;if(!env||typeof env!=='object')throw error('proxy_unsupported');configured=PROXY_NAMES.some(name=>present(env[name]));const proxy=configuredProxy(env);
    if(!adapterValid(options.managedAdapter))return blocked('adapter_invalid',configured);// No reviewed managed final-resolution/public-address/dial-binding implementation is installed.
    // A callable send (or successful fixed-target GET) is not that capability.
    if(proxy)return blocked('proxy_policy_unverified',true);
    return projectCallbackTransportStatus({ready:true,mode:'direct',reason:'none',proxy_configured:false,destination_binding:'direct_pinned',network_checked:false});
  }catch{return blocked('proxy_unsupported',configured);}
}
const REQUEST_HEADERS=new Set(['content-type','webhook-id','webhook-timestamp','webhook-signature','x-mcp-subscription-id']);
function requestHeaders(input,url,size){
  if(!input||typeof input!=='object'||Array.isArray(input))throw error('invalid_input');const h=Object.create(null);let bytes=0;
  for(const[k,v]of Object.entries(input)){const n=k.toLowerCase();if(!REQUEST_HEADERS.has(n)||Object.hasOwn(h,n)||typeof v!=='string'||!/^[\x20-\x7e]{1,1024}$/.test(v))throw error('invalid_input');h[n]=v;bytes+=n.length+v.length+4;}
  if(bytes>MAX_BYTES||(h['content-type']&&h['content-type']!=='application/json'))throw error('invalid_input');return {...h,host:url.hostname,'content-length':String(size),accept:'application/json','accept-encoding':'identity'};
}
const CRITICAL=new Set(['content-type','content-length','content-encoding','transfer-encoding','location']);
// Shared internal response projection for reviewed transport implementations.
export function responseHeaders(res,maxBytes){
  if(!Array.isArray(res.rawHeaders)||res.rawHeaders.length%2||res.rawHeaders.length>64||!res.headers||typeof res.headers!=='object'||Array.isArray(res.headers))throw error('invalid_response');
  const h=Object.create(null),names=new Set();let size=0;
  for(let i=0;i<res.rawHeaders.length;i+=2){const k=res.rawHeaders[i],v=res.rawHeaders[i+1];if(typeof k!=='string'||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)||typeof v!=='string'||/[^\x09\x20-\x7e]/.test(v))throw error('invalid_response');const n=k.toLowerCase();size+=k.length+v.length+4;if(size>MAX_BYTES||(CRITICAL.has(n)&&names.has(n)))throw error('invalid_response');names.add(n);if(CRITICAL.has(n))h[n]=v;}
  const parsed=Object.entries(res.headers);if(parsed.length!==names.size||parsed.some(([n,v])=>n!==n.toLowerCase()||!names.has(n)||(CRITICAL.has(n)&&h[n]!==v)))throw error('invalid_response');
  if(h['content-encoding']&&h['content-encoding'].trim().toLowerCase()!=='identity')throw error('invalid_response');if(h['transfer-encoding']&&h['transfer-encoding'].trim().toLowerCase()!=='chunked')throw error('invalid_response');if(h['transfer-encoding']&&h['content-length'])throw error('invalid_response');
  if(h['content-length']!==undefined&&(!/^(?:0|[1-9]\d{0,8})$/.test(h['content-length'])||Number(h['content-length'])>maxBytes))throw error('invalid_response');return h;
}
function statusCode(status){if(!Number.isInteger(status)||status<200||status>599)throw error('invalid_response');if(status>=300&&status<400)throw error('redirect_rejected');}
export function makeCallbackTransport(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options))throw error('invalid_options');
  const {lookup=dnsLookup,request=https.request,timeoutMs=10000,maxBytes=MAX_BODY_BYTES,maxRequestBytes=MAX_BODY_BYTES,proxyEnv=process.env,managedAdapter,callbackPolicy='exact-hosts'}=options;
  if(typeof lookup!=='function'||typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BODY_BYTES||!Number.isInteger(maxRequestBytes)||maxRequestBytes<1||maxRequestBytes>MAX_BODY_BYTES||!['exact-hosts','authenticated-dynamic-public-https'].includes(callbackPolicy))throw error('invalid_options');
  let adapterSend;try{adapterSend=managedAdapter?.send;}catch{throw error('adapter_invalid');}let initialProxy;try{initialProxy=configuredProxy(proxyEnv);}catch{}
  const fingerprint=p=>JSON.stringify(p?{url:p.url.href,authorization:p.authorization,noProxy:p.noProxy}:null);
  const preflight=()=>{let configured=false;try{const s=preflightCallbackTransport({proxyEnv,managedAdapter});configured=s.proxy_configured;if(managedAdapter?.send!==adapterSend)return blocked('adapter_invalid',configured);if(!s.ready)return s;if(fingerprint(configuredProxy(proxyEnv))!==fingerprint(initialProxy))return blocked('proxy_unsupported',configured);return s;}catch{return blocked('proxy_unsupported',configured);}};
  const send=async(raw,{method='POST',headers={},body=Buffer.alloc(0),hosts,beforeConnect,signal}={})=>{
    const url=validateCallbackUrl(raw);if(callbackPolicy==='exact-hosts'){if(!Array.isArray(hosts)||hosts.length>64||hosts.some(x=>!hostnameIsDns(x))||!hosts.includes(url.hostname))throw error('host_not_allowed');}else if(hosts!==undefined&&(!Array.isArray(hosts)||hosts.length))throw error('invalid_input');
    if(method!=='POST'||typeof beforeConnect!=='function'||(signal!==undefined&&!(signal instanceof AbortSignal)))throw error('invalid_input');const payload=bodyBytes(body,maxRequestBytes),outgoing=requestHeaders(headers,url,payload.length);const state=preflight();if(!state.ready)throw error(state.reason);const proxy=configuredProxy(proxyEnv);if(bypassMatches(proxy,url.hostname))throw error('proxy_unsupported');
    let failure,finished=false,req,res,timer;const cancellation=new AbortController(),listeners=new Map();
    const detach=(emitter,record)=>{for(const[n,f]of record)emitter.removeListener(n,f);record.length=0;};
    const on=(emitter,name,fn)=>{let record=listeners.get(emitter);if(!record){record=[];listeners.set(emitter,record);const close=()=>{if(finished)detach(emitter,record);};emitter.on('close',close);record.push(['close',close]);}emitter.on(name,fn);record.push([name,fn]);};
    let rejectFailure;const stopped=new Promise((_,reject)=>rejectFailure=reject);stopped.catch(()=>{});
    const fail=code=>{if(finished||failure)return;failure=error(code);rejectFailure(failure);cancellation.abort();try{res?.destroy();}catch{}try{req?.destroy();}catch{}};
    const active=()=>{if(finished)throw error('aborted');if(signal?.aborted)fail('aborted');if(failure)throw failure;};
    const wait=async(operation,code)=>{const p=Promise.resolve(operation);p.catch(()=>{});active();try{const value=await Promise.race([p,stopped]);active();return value;}catch{if(!failure)fail(code);throw failure;}};
    const gate=(operation)=>{active();if(operation!==undefined&&typeof operation!=='function')throw error('invalid_input');let approval;try{approval=beforeConnect();}catch{fail('gate_failed');active();}const perform=()=>{active();return operation?.();};if(approval&&typeof approval.then==='function')return wait(approval,'gate_failed').then(perform);return perform();};
    const abort=()=>fail('aborted');signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>fail('timeout'),timeoutMs);
    try{
      const result=await wait(gate(()=>lookup(url.hostname,{all:true,verbatim:true})),'dns_failed');await gate();active();
      if(!Array.isArray(result)||!result.length||result.length>32||result.some(a=>!a||typeof a!=='object'||!publicAddress(a.address)||isIP(a.address)!==a.family))throw error('blocked_address');
      if(bypassMatches(proxy,url.hostname,result.map(a=>a.address)))throw error('proxy_unsupported');
      const addresses=Object.freeze(result.map(a=>Object.freeze({address:a.address,family:a.family}))),pinned=addresses[0];
      // Managed egress is rejected before DNS by preflight until a concrete
      // reviewed implementation owns the final resolution/validation/dial step.
      // Local DNS here belongs only to the direct pinned path.
      const pinnedLookup=(host,opts,callback)=>{if(typeof opts==='function'){callback=opts;opts={};}if(typeof callback!=='function')return;if(finished||failure||signal?.aborted||host!==url.hostname){callback(error(signal?.aborted?'aborted':'connection_failed'));return;}if(opts?.all)callback(null,[{...pinned}]);else callback(null,pinned.address,pinned.family);};
      let resolveResponse;const response=new Promise(resolve=>resolveResponse=resolve);
      const receive=incoming=>{
        res=incoming;on(res,'error',()=>fail('connection_failed'));on(res,'aborted',()=>fail('connection_failed'));if(finished||failure||signal?.aborted){try{res.destroy();}catch{}return;}
        let h;try{statusCode(res.statusCode);h=responseHeaders(res,maxBytes);}catch(caught){fail(caught instanceof CallbackTransportError?caught.code:'invalid_response');return;}
        const chunks=[];let bytes=0;on(res,'data',chunk=>{if(finished||failure)return;if(!Buffer.isBuffer(chunk)){fail('invalid_response');return;}bytes+=chunk.length;if(bytes>maxBytes){fail('response_too_large');return;}chunks.push(Buffer.from(chunk));});
        on(res,'end',()=>{if(finished||failure)return;if(res.complete===false||res.aborted||(h['content-length']!==undefined&&Number(h['content-length'])!==bytes)){fail('invalid_response');return;}resolveResponse({status:res.statusCode,headers:h,body:Buffer.concat(chunks,bytes)});});on(res,'close',()=>{if(!res.complete)fail('connection_failed');});
      };
      try{await gate(()=>{req=request(url,{method:'POST',headers:outgoing,agent:false,lookup:pinnedLookup,family:pinned.family,autoSelectFamily:false,servername:url.hostname,rejectUnauthorized:true,maxHeaderSize:MAX_BYTES,insecureHTTPParser:false,joinDuplicateHeaders:false},receive);req.maxHeadersCount=32;
        on(req,'error',caught=>fail(typeof caught?.code==='string'&&(caught.code.startsWith('ERR_TLS')||caught.code.includes('CERT'))?'tls_failed':'connection_failed'));on(req,'close',()=>{if(!res?.complete&&!finished)fail('connection_failed');});on(req,'upgrade',(response,socket)=>{try{response?.destroy();socket?.destroy();}catch{}fail('invalid_response');});});}catch{fail('connection_failed');active();}
      await gate(()=>{try{req.end(payload);}catch{fail('connection_failed');}});const delivered=await wait(response,'connection_failed');await gate();active();return delivered;
    }catch(caught){if(!failure)fail(caught instanceof CallbackTransportError?caught.code:'connection_failed');throw failure;}
    finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);cancellation.abort();try{res?.destroy();}catch{}try{req?.destroy();}catch{}
      for(const[emitter,record]of listeners){if(emitter.closed)detach(emitter,record);else{for(const[name,fn]of record)if(name!=='error'&&name!=='close')emitter.removeListener(name,fn);listeners.set(emitter,record.filter(([name])=>name==='error'||name==='close'));}}
    }
  };
  Object.defineProperty(send,'preflight',{value:preflight,enumerable:true});return send;
}

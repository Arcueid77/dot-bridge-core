import test from 'node:test';
import assert from 'node:assert/strict';
import {makeOwnerScopedProxyTransport,ownerScopedProxyStatus} from '../owner-scoped.js';
import {signedHeaders,makeCallbackTransport,projectCallbackTransportStatus} from '../index.js';
const url='https://callback.example.test/owner-scope',sub='sub_'+'a'.repeat(64);
const challenge={type:'verification',challenge:'c'.repeat(43)};
function fixture(extra={}){
 const time={value:Date.now()},calls=[],env={HTTPS_PROXY:'http://proxy.example.test:3128'};
 const grant={principal:'tunnel-owner:dot-bridge',url,subscription_id:sub,expires:time.value+3600000,verified:true};
 const sender=makeOwnerScopedProxyTransport({channel:'lark',proxyEnv:env,now:()=>time.value,connect:async(u,p,r)=>{
  await r.beforeConnect(()=>{});const value=JSON.parse(r.body);calls.push({url:u.href,proxy:p.href,value,headers:r.headers});
  return{status:200,body:Buffer.from(JSON.stringify(value.type==='verification'?{challenge:value.challenge}:{}))};
 },...extra});
 const event=(n=1)=>({eventId:'evt_'+String(n).padStart(64,'0'),name:'lark.message.created',timestamp:new Date(time.value).toISOString(),data:{message_id:`message-${n}`,conversation:'owner',text:`Owner text ${n}`,reply_deadline:new Date(time.value+300000).toISOString()},cursor:null});
 const request=(value,more={})=>{const body=Buffer.from(JSON.stringify(value));return{body,headers:signedHeaders({id:sub,key:Buffer.alloc(32,1)},value.type==='verification'?'verify_'+'d'.repeat(32):value.eventId,body,time.value),hosts:['callback.example.test'],beforeConnect:()=>({...grant}),...more};};
 return{sender,time,calls,env,grant,event,request};
}
test('explicit continuous owner mode delivers several distinct events and keeps unverified status',async()=>{
 const f=fixture();const status=f.sender.preflight();assert.equal(status.mode,'owner_scoped_proxy');assert.equal(status.destination_binding,'unverified');assert.equal(status.network_checked,false);
 assert.deepEqual(ownerScopedProxyStatus(f.sender,f.env),status);assert.equal(ownerScopedProxyStatus(()=>{},f.env),null);
 f.grant.verified=false;await f.sender(url,f.request(challenge));await assert.rejects(f.sender(url,f.request(f.event())),e=>e.code==='gate_failed');
 f.grant.verified=true;await f.sender(url,f.request(f.event(1)));await f.sender(url,f.request(f.event(2)));assert.equal(f.calls.length,3);
 assert.equal(makeCallbackTransport({proxyEnv:f.env}).preflight().reason,'proxy_policy_unverified');
 for(const change of [{destination_binding:'direct_pinned'},{network_checked:true},{proxy_configured:false},{ready:false}])assert.throws(()=>projectCallbackTransportStatus({...status,...change}));
});
test('each request requires exact current owner authority, URL, ID, expiry and event verification',async()=>{
 const f=fixture();for(const change of [{principal:'other'},{url:url+'/other'},{subscription_id:'sub_'+'f'.repeat(64)},{expires:f.time.value},{expires:Infinity},{verified:false},{verified:'true'},{secret:'synthetic-private'}])await assert.rejects(f.sender(url,f.request(f.event(),{beforeConnect:()=>({...f.grant,...change})})),e=>e.code==='gate_failed');
 await assert.rejects(f.sender(url,f.request(f.event(),{beforeConnect:()=>undefined})));assert.equal(f.calls.length,0);
 await f.sender(url,f.request(f.event()));assert.equal(f.calls.length,1);
});
test('restored verified Store authority permits events without repeating verification and rechecks authority after I/O',async()=>{
 const f=fixture();await f.sender(url,f.request(f.event()));assert.equal(f.calls.length,1);
 let gates=0;const g=fixture();await assert.rejects(g.sender(url,g.request(g.event(),{beforeConnect:()=>++gates===3?{...g.grant,verified:false}:{...g.grant}})),e=>e.code==='delivery_uncertain');
 assert.equal(g.calls.length,1);await assert.rejects(g.sender(url,g.request(g.event())),e=>e.code==='event_replayed');
});
test('duplicate or mutated event ID never discloses another body and expired payload cannot replay',async()=>{
 const f=fixture(),event=f.event();await f.sender(url,f.request(event));
 for(const value of [event,{...event,data:{...event.data,text:'changed'}}])await assert.rejects(f.sender(url,f.request(value)),e=>e.code==='event_replayed');
 f.time.value=Date.parse(event.data.reply_deadline);await assert.rejects(f.sender(url,f.request(event)),e=>e.code==='invalid_input');
 await f.sender(url,f.request(f.event(2)));assert.equal(f.calls.length,2);
});
test('busy and capacity rejection occur before another attempt and may be safely rescheduled locally',async()=>{
 let release;const f=fixture({connect:()=>new Promise(resolve=>{release=()=>resolve({status:200,body:Buffer.from('{}')});})});
 const first=f.sender(url,f.request(f.event()));while(!release)await Promise.resolve();
 await assert.rejects(f.sender(url,f.request(f.event(2))),e=>e.code==='request_busy');assert.equal(f.sender.state().tracked_events,1);release();await first;
 const g=fixture({maxTrackedEvents:1});await g.sender(url,g.request(g.event()));await assert.rejects(g.sender(url,g.request(g.event(2))),e=>e.code==='capacity_exceeded');assert.equal(g.calls.length,1);
 g.time.value+=300000;await g.sender(url,g.request(g.event(3)));assert.equal(g.calls.length,2);
});
test('attempted failures remain uncertain, do not retry, and explicit 410 remains available for revocation',async()=>{
 for(const response of [{status:503,body:Buffer.from('{}')},{status:429,body:Buffer.from('{}')},{status:302,body:Buffer.from('{}')},{status:200,body:Buffer.alloc(8193)},null]){
  let calls=0;const f=fixture({connect:async()=>{calls++;if(response===null)throw Error('synthetic-private');return response;}});
  await assert.rejects(f.sender(url,f.request(f.event())),e=>e.code==='delivery_uncertain'&&!String(e).includes('private'));await assert.rejects(f.sender(url,f.request(f.event())),e=>e.code==='event_replayed');assert.equal(calls,1);
 }
 const f=fixture({connect:async()=>({status:410,body:Buffer.alloc(0)})});assert.equal((await f.sender(url,f.request(f.event()))).status,410);await assert.rejects(f.sender(url,f.request(f.event())),e=>e.code==='event_replayed');
});
test('invalid envelopes, missing host constraints and NO_PROXY deny before any callback',async()=>{
 const f=fixture();for(const hosts of [undefined,[],['other.example.test']])await assert.rejects(f.sender(url,f.request(f.event(),{hosts})));
 for(const mutate of [v=>v.name='qq.message.created',v=>v.data.conversation='other',v=>v.data.extra='private',v=>v.data.text='\u0000',v=>v.data.text='x'.repeat(2001)]){const value=f.event();mutate(value);await assert.rejects(f.sender(url,f.request(value)));}assert.equal(f.calls.length,0);
 const g=fixture({proxyEnv:{HTTPS_PROXY:'http://proxy.example.test',NO_PROXY:'callback.example.test'}});await assert.rejects(g.sender(url,g.request(g.event())),e=>e.code==='proxy_unsupported');
});
test('total deadline covers pending authorization and attempted callback without late success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();const gated=f.sender(url,f.request(f.event(),{beforeConnect:()=>new Promise(()=>{})}));t.mock.timers.tick(10000);await assert.rejects(gated,e=>e.code==='timeout');assert.equal(f.sender.state().tracked_events,0);
 let release;const g=fixture({connect:()=>new Promise(resolve=>{release=()=>resolve({status:200,body:Buffer.from('{}')});})});const pending=g.sender(url,g.request(g.event()));while(!release)await Promise.resolve();t.mock.timers.tick(10000);await assert.rejects(pending,e=>e.code==='delivery_uncertain');release();await Promise.resolve();await assert.rejects(g.sender(url,g.request(g.event())),e=>e.code==='event_replayed');
});
test('close and proxy change cannot reopen a route or report a successful uncertain attempt',async()=>{
 let release;const f=fixture({connect:()=>new Promise(resolve=>{release=resolve;})});const pending=f.sender(url,f.request(f.event()));while(!release)await Promise.resolve();f.sender.close();await assert.rejects(pending,e=>e.code==='delivery_uncertain');assert.equal(f.sender.preflight().reason,'scope_closed');
 const g=fixture();g.env.HTTPS_PROXY='http://different.example.test';assert.equal(g.sender.preflight().reason,'proxy_unsupported');await assert.rejects(g.sender(url,g.request(g.event())));assert.equal(g.calls.length,0);
});


test('a shorter authorization lease at a later connection gate shortens the active request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reached=false,gates=0;
 const f=fixture({connect:async(_u,_p,r)=>{await r.beforeConnect();reached=true;return new Promise(()=>{});}});
 const pending=f.sender(url,f.request(f.event(),{beforeConnect:()=>({...f.grant,expires:++gates===1?f.grant.expires:f.time.value+5})}));
 while(!reached)await Promise.resolve();t.mock.timers.tick(6);await assert.rejects(pending,e=>e.code==='delivery_uncertain');
});

import test from 'node:test';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {makeOwnerMessageExperimentTransport,ownerMessageExperimentStatus} from '../experimental/owner-message.js';
import {signedHeaders,makeCallbackTransport,projectCallbackTransportStatus} from '../index.js';
const url='https://callback.example.test/one-owner';
const expectedText='owner connection test';
const subscription='sub_'+'a'.repeat(64),eventId='evt_'+'b'.repeat(64);
const challenge=()=>({type:'verification',challenge:'c'.repeat(43)});
function fixture(channel='qq',extra={}){
 const time={value:Date.now()},calls=[],env={HTTPS_PROXY:'http://proxy.example.test:3128',NO_PROXY:'127.0.0.1,10.0.0.0/8'};
 const send=makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel,expectedText,deadlineMs:time.value+60000,proxyEnv:env,now:()=>time.value,connect:async(u,p,r)=>{await r.beforeConnect(()=>{});const value=JSON.parse(r.body);calls.push({url:u.href,proxy:p.href,value,headers:r.headers});return {status:200,body:Buffer.from(JSON.stringify(value.type==='verification'?{challenge:value.challenge}:{}))};},...extra});
 const event=()=>({eventId,name:`${channel}.message.created`,timestamp:new Date(time.value).toISOString(),data:{message_id:'fixture-message',conversation:'owner',text:expectedText,reply_deadline:new Date(time.value+300000).toISOString()},cursor:null});
 return {send,calls,env,time,event};
}
async function waitFor(predicate){for(let i=0;i<12&&!predicate();i++)await Promise.resolve();assert.ok(predicate());}
function request(value,extra={}){const body=Buffer.from(JSON.stringify(value));const id=value.type==='verification'?'verify_'+'d'.repeat(32):value.eventId;return {headers:signedHeaders({id:subscription,key:Buffer.alloc(32,1)},id,body,Date.now()),body,beforeConnect(){},...extra};}
for(const channel of ['qq','lark'])test(`${channel}: exact one owner message after verified challenge; readiness remains for fixed reply`,async()=>{
 const f=fixture(channel);assert.equal(ownerMessageExperimentStatus(f.send,f.env).mode,'owner_single_message_proxy');await f.send(url,request(challenge()));assert.equal(f.send.state().challenge_verified,true);await f.send(url,request(f.event()));assert.equal(f.send.state().event_accepted,true);assert.equal(f.send.preflight().ready,true);assert.equal(f.calls.length,2);
 await assert.rejects(f.send(url,request(f.event())),e=>e.code==='invalid_input');await assert.rejects(f.send(url,request(challenge())),e=>e.code==='invalid_input');assert.equal(f.calls.length,2);assert.equal(f.send.state().final_address_binding,'unverified');
});
test('factory requires explicit approval, channel, exact text, deadline and original proxy',()=>{
 const now=Date.now(),base={approvedOwnerMessageExperiment:true,channel:'qq',expectedText,deadlineMs:now+60000,proxyEnv:{HTTPS_PROXY:'http://proxy.example.test'},now:()=>now};
 for(const fields of [{approvedOwnerMessageExperiment:false},{approvedOwnerMessageExperiment:'true'},{channel:'other'},{expectedText:''},{expectedText:'x'.repeat(1025)},{deadlineMs:now-1},{deadlineMs:now+900001},{proxyEnv:{}},{proxyEnv:{HTTPS_PROXY:'http://user:pass@proxy.example.test'}}])assert.throws(()=>makeOwnerMessageExperimentTransport({...base,...fields}));
});
test('identity recognition rejects forged readiness and mismatched proxy environment',()=>{
 const f=fixture();assert.equal(ownerMessageExperimentStatus({preflight:()=>f.send.preflight()},f.env),null);assert.equal(ownerMessageExperimentStatus(()=>{},f.env),null);assert.equal(ownerMessageExperimentStatus(f.send,{HTTPS_PROXY:'http://another.example.test'}).ready,false);assert.throws(()=>{f.send.preflight=()=>({ready:true});});
 delete f.env.HTTPS_PROXY;assert.equal(f.send.preflight().ready,false);
});
test('deadline and close revoke scope without resetting budgets',async()=>{
 const f=fixture();await f.send(url,request(challenge()));f.time.value+=60001;assert.equal(f.send.preflight().ready,false);await assert.rejects(f.send(url,request(f.event())),e=>e.code==='aborted');assert.equal(f.calls.length,1);
 const g=fixture();g.send.close();assert.equal(g.send.preflight().ready,false);await assert.rejects(g.send(url,request(challenge())),e=>e.code==='aborted');
});
test('failed or wrong-echo challenge consumes one attempt and cannot authorize an event',async()=>{
 for(const response of [{status:503,body:Buffer.from('{}')},{status:200,body:Buffer.from('{"challenge":"wrong"}')}]){
  let calls=0;const f=fixture('qq',{connect:async()=>{calls++;return response;}});await f.send(url,request(challenge()));assert.equal(f.send.state().challenge_verified,false);await assert.rejects(f.send(url,request(f.event())));await assert.rejects(f.send(url,request(challenge())));assert.equal(calls,1);
 }
});
test('HTTP event failure cannot retry or expand allowance',async()=>{
 const f=fixture();await f.send(url,request(challenge()));f.calls.length=0;
 // Invalid redirects reject without making another attempt.
 const g=fixture('qq',{connect:async(u,p,r)=>JSON.parse(r.body).type==='verification'?{status:200,body:Buffer.from(JSON.stringify({challenge:challenge().challenge}))}:{status:503,body:Buffer.from('{}')}});
 await g.send(url,request(challenge()));assert.equal((await g.send(url,request(g.event()))).status,503);assert.equal(g.send.state().event_attempted,true);assert.equal(g.send.state().event_accepted,false);await assert.rejects(g.send(url,request(g.event())));
});
test('one bound complete URL and subscription; wrong owner/text/channel/extra fields rejected',async()=>{
 const f=fixture();await f.send(url,request(challenge()));await assert.rejects(f.send(url+'/different',request(f.event())),e=>e.code==='host_not_allowed');
 const variants=[x=>x.name='lark.message.created',x=>x.data.conversation='other',x=>x.data.text='different',x=>x.data.secret='PRIVATE_CANARY',x=>x.data.message_id='',x=>x.data.reply_deadline='invalid',x=>x.eventId='evt_short'];
 for(const mutate of variants){const value=f.event();mutate(value);await assert.rejects(f.send(url,request(value)));}
 const r=request(f.event());r.headers['x-mcp-subscription-id']='sub_'+'e'.repeat(64);await assert.rejects(f.send(url,r));assert.equal(f.calls.length,1);
});
test('real header casing works; duplicates, extra headers and noncanonical body cannot hide data',async()=>{
 const f=fixture();const r=request(challenge());r.headers['Content-Type']=r.headers['content-type'];delete r.headers['content-type'];r.headers['X-MCP-Subscription-Id']=r.headers['x-mcp-subscription-id'];delete r.headers['x-mcp-subscription-id'];await f.send(url,r);
 for(const mutate of [r=>r.headers.Authorization='PRIVATE_CANARY',r=>r.headers['Content-Type']='application/json',r=>r.body=Buffer.from('{"type":"verification","challenge":"PRIVATE_CANARY","challenge":"'+'c'.repeat(43)+'"}')]){const g=fixture();const value=request(challenge());mutate(value);await assert.rejects(g.send(url,value));assert.equal(g.calls.length,0);}
});
test('NO_PROXY hostname rejects; CIDR does not silently become direct routing',async()=>{
 for(const value of ['callback.example.test','*','.example.test']){const f=fixture('qq',{proxyEnv:{HTTPS_PROXY:'http://proxy.example.test',NO_PROXY:value}});await assert.rejects(f.send(url,request(challenge())),e=>e.code==='proxy_unsupported');assert.equal(f.calls.length,0);}
 const f=fixture('qq',{proxyEnv:{HTTPS_PROXY:'http://proxy.example.test:3128',NO_PROXY:'93.184.216.0/24'}});await f.send(url,request(challenge()));assert.equal(f.calls[0].proxy,'http://proxy.example.test:3128/');
});
test('beforeConnect authorization is awaited and failures do not perform network',async()=>{
 const f=fixture();await assert.rejects(f.send(url,request(challenge(),{beforeConnect:async()=>{throw Error('PRIVATE_CANARY');}})),e=>e.code==='gate_failed');assert.equal(f.calls.length,0);
 await f.send(url,request(challenge(),{beforeConnect:async()=>{}}));assert.equal(f.calls.length,1);
});
test('concurrent sends cannot consume a second challenge or event budget',async()=>{
 let release;const f=fixture('qq',{connect:()=>new Promise(resolve=>{release=resolve;})});const first=f.send(url,request(challenge()));await waitFor(()=>release);await assert.rejects(f.send(url,request(challenge())),e=>e.code==='invalid_input');release({status:200,body:Buffer.from(JSON.stringify({challenge:challenge().challenge}))});await first;assert.equal(f.send.state().challenge_verified,true);
});
test('abort and timeout stop waits; late rejection cannot retry',async t=>{
 const controller=new AbortController();let reject;const f=fixture('qq',{connect:()=>new Promise((_,r)=>{reject=r;})});const promise=f.send(url,request(challenge(),{signal:controller.signal}));await waitFor(()=>reject);controller.abort();await assert.rejects(promise,e=>e.code==='aborted');reject(Error('PRIVATE_CANARY'));await Promise.resolve();await assert.rejects(f.send(url,request(challenge())));
 t.mock.timers.enable({apis:['setTimeout']});const g=fixture('qq',{connect:()=>new Promise(()=>{})});const pending=g.send(url,request(challenge()));await Promise.resolve();t.mock.timers.tick(10000);await assert.rejects(pending,e=>e.code==='timeout');
});
test('new status preserves unverified destination and does not alter default readiness',()=>{
 const f=fixture(),s=f.send.preflight();assert.equal(s.ready,true);assert.equal(s.mode,'owner_single_message_proxy');assert.equal(s.destination_binding,'unverified');assert.equal(s.network_checked,false);assert.deepEqual(projectCallbackTransportStatus(s),s);
 for(const change of [{destination_binding:'direct_pinned'},{proxy_configured:false},{reason:'proxy_policy_unverified'},{ready:false}])assert.throws(()=>projectCallbackTransportStatus({...s,...change}));
 assert.equal(makeCallbackTransport({proxyEnv:{HTTPS_PROXY:'http://proxy.example.test'}}).preflight().ready,false);
});


test('initial async authorization gate is bounded by caller abort, close and deadline',async t=>{
 for(const action of ['abort','close']){const f=fixture(),c=new AbortController();const pending=f.send(url,request(challenge(),{beforeConnect:()=>new Promise(()=>{}),signal:c.signal}));if(action==='abort')c.abort();else f.send.close();await assert.rejects(pending,e=>e.code==='aborted');assert.equal(f.calls.length,0);assert.equal(f.send.state().challenge_attempted,false);}
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();const pending=f.send(url,request(challenge(),{beforeConnect:()=>new Promise(()=>{})}));t.mock.timers.tick(10000);await assert.rejects(pending,e=>e.code==='timeout');assert.equal(f.calls.length,0);
});
test('post-response async authorization gate cannot hang or report late success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let gates=0,release;const f=fixture();const pending=f.send(url,request(challenge(),{beforeConnect:()=>{gates++;if(gates===3)return new Promise(resolve=>{release=resolve;});}}));await waitFor(()=>release);t.mock.timers.tick(10000);await assert.rejects(pending,e=>e.code==='timeout');assert.equal(f.send.state().challenge_verified,false);assert.equal(f.calls.length,1);release();await Promise.resolve();assert.equal(f.send.state().challenge_verified,false);
});

test('microtask cancellation after an authority gate cannot open a socket or report success',async()=>{
 for(const gateNumber of [1,3])for(const action of ['abort','close']){
  const f=fixture(),controller=new AbortController();let gates=0;
  const pending=f.send(url,request(challenge(),{signal:controller.signal,beforeConnect:()=>{if(++gates===gateNumber)queueMicrotask(()=>action==='abort'?controller.abort():f.send.close());}}));
  await assert.rejects(pending,e=>e.code==='aborted');assert.equal(f.calls.length,gateNumber===1?0:1);assert.equal(f.send.state().challenge_verified,false);assert.equal(f.send.state().event_accepted,false);
 }
});

test('any-owner-text mode accepts one ordinary text without an expected phrase and preserves its bytes',async()=>{
 for(const text of ['你好，今天聊点什么？','自由输入，不是预设口令。\n第二行 😀','  保留本人原始空格  ','中'.repeat(2000),'😀'.repeat(1000)]){
  const f=fixture('lark',{acceptAnyOwnerText:true,expectedText:undefined});await f.send(url,request(challenge()));const value=f.event();value.data.text=text;await f.send(url,request(value));
  assert.equal(f.calls.at(-1).value.data.text,text);assert.equal(f.send.state().event_accepted,true);assert.equal(f.calls.length,2);
  value.eventId='evt_'+'f'.repeat(64);value.data.message_id='another-message';value.data.text='另一条本人消息';await assert.rejects(f.send(url,request(value)));assert.equal(f.calls.length,2);
 }
});
test('any-owner-text is an explicit boolean choice and supersedes a stale expected phrase',async()=>{
 for(const acceptAnyOwnerText of ['true',1,null,{},()=>true])assert.throws(()=>fixture('lark',{acceptAnyOwnerText}),e=>e.code==='invalid_options');
 const f=fixture('lark',{acceptAnyOwnerText:true,expectedText:'旧的指定句子'});await f.send(url,request(challenge()));const value=f.event();value.data.text='用户现在选择的自由文本';await f.send(url,request(value));assert.equal(f.calls.length,2);
 const old=fixture('lark');await old.send(url,request(challenge()));await assert.rejects(old.send(url,request(value)),e=>e.code==='invalid_input');assert.equal(old.calls.length,1);
});
test('ordinary text rejects empty, nontext, control, invalid Unicode and excessive content without consuming the message',async()=>{
 const f=fixture('lark',{acceptAnyOwnerText:true,expectedText:undefined});await f.send(url,request(challenge()));
 for(const text of ['', ' \n\t ', null, 42, {text:'not a string'}, 'control\u0000text','invalid\ud800','x'.repeat(2001)]){const value=f.event();value.data.text=text;await assert.rejects(f.send(url,request(value)),e=>e.code==='invalid_input');}
 assert.equal(f.calls.length,1);assert.equal(f.send.state().event_attempted,false);const value=f.event();value.data.text='有效的本人文字';await f.send(url,request(value));assert.equal(f.calls.length,2);
});
test('any-owner-text does not relax channel, owner marker, body shape, URL or subscription binding',async()=>{
 const f=fixture('lark',{acceptAnyOwnerText:true,expectedText:undefined});await f.send(url,request(challenge()));
 for(const mutate of [v=>v.name='qq.message.created',v=>v.data.conversation='other',v=>v.data.secret='PRIVATE_CANARY',v=>v.extra='PRIVATE_CANARY']){const value=f.event();value.data.text='自由的本人文字';mutate(value);await assert.rejects(f.send(url,request(value)));}
 const value=f.event();value.data.text='自由的本人文字';await assert.rejects(f.send(url+'/changed',request(value)),e=>e.code==='host_not_allowed');const r=request(value);r.headers['x-mcp-subscription-id']='sub_'+'f'.repeat(64);await assert.rejects(f.send(url,r));assert.equal(f.calls.length,1);
});


test('renewable waiting is explicit and requires a fresh lease before any callback',async()=>{
 for(const waitForOwner of [1,'true',null])assert.throws(()=>fixture('lark',{waitForOwner,deadlineMs:undefined}));
 assert.throws(()=>fixture('lark',{waitForOwner:true}));
 const fixed=fixture();assert.throws(()=>fixed.send.renewLease(fixed.time.value+100000));
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});
 assert.equal(f.send.state().deadline_ms,null);assert.equal(f.send.preflight().ready,false);
 await assert.rejects(f.send(url,request(challenge())),e=>e.code==='aborted');assert.equal(f.calls.length,0);
 for(const expiry of [undefined,NaN,Infinity,f.time.value,f.time.value-1,1.5])assert.throws(()=>f.send.renewLease(expiry));
 // Authenticated subscription expiry, not the old fifteen-minute session cap.
 f.send.renewLease(f.time.value+3600000);assert.equal(f.send.preflight().ready,true);
 await f.send(url,request(challenge()));assert.equal(f.calls.length,1);
});

test('expired owner waiting may renew the same binding without restoring challenge or event budgets',async()=>{
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});
 f.send.renewLease(f.time.value+1000);await f.send(url,request(challenge()));
 f.time.value+=1001;assert.equal(f.send.preflight().ready,false);
 await assert.rejects(f.send(url,request(f.event())),e=>e.code==='aborted');assert.equal(f.calls.length,1);
 f.send.renewLease(f.time.value+3600000);assert.equal(f.send.preflight().ready,true);
 await assert.rejects(f.send(url,request(challenge())),e=>e.code==='invalid_input');
 await assert.rejects(f.send(url+'/changed',request(f.event())),e=>e.code==='host_not_allowed');
 const wrong=request(f.event());wrong.headers['x-mcp-subscription-id']='sub_'+'f'.repeat(64);
 await assert.rejects(f.send(url,wrong),e=>e.code==='invalid_input');assert.equal(f.calls.length,1);
 await f.send(url,request(f.event()));assert.equal(f.calls.length,2);
 await assert.rejects(f.send(url,request(f.event())),e=>e.code==='invalid_input');
});

test('first owner event locks the shorter message or subscription deadline and cannot be renewed',async()=>{
 for(const leaseDuration of [60000,3600000]){
  const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});
  f.send.renewLease(f.time.value+leaseDuration);await f.send(url,request(challenge()));
  const value=f.event(),replyDeadline=Date.parse(value.data.reply_deadline);
  await f.send(url,request(value));const locked=Math.min(f.time.value+leaseDuration,replyDeadline);
  assert.equal(f.send.state().deadline_ms,locked);assert.equal(f.send.preflight().ready,true);
  assert.throws(()=>f.send.renewLease(locked+3600000),e=>e.code==='invalid_options');
  assert.equal(f.send.state().deadline_ms,locked);
  f.time.value=locked;assert.equal(f.send.preflight().ready,false);
  assert.throws(()=>f.send.renewLease(locked+3600000));
 }
});

test('waiting renewal cannot revive close or a failed challenge, mutate proxy, or race an in-flight request',async()=>{
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});f.send.close();assert.throws(()=>f.send.renewLease(f.time.value+60000));
 const g=fixture('lark',{waitForOwner:true,deadlineMs:undefined,connect:async()=>({status:503,body:Buffer.from('{}')})});
 g.send.renewLease(g.time.value+60000);await g.send(url,request(challenge()));assert.throws(()=>g.send.renewLease(g.time.value+120000));
 const h=fixture('lark',{waitForOwner:true,deadlineMs:undefined});h.send.renewLease(h.time.value+60000);
 let release;const pending=h.send(url,request(challenge(),{beforeConnect:()=>new Promise(r=>{release=r;})}));
 await waitFor(()=>release);assert.throws(()=>h.send.renewLease(h.time.value+120000));h.send.close();await assert.rejects(pending);release();
 const i=fixture('lark',{waitForOwner:true,deadlineMs:undefined});i.env.HTTPS_PROXY='http://different.example.test';i.send.renewLease(i.time.value+60000);assert.equal(i.send.preflight().ready,false);
});

test('renewable waiting keeps lease and message expiry inside the total asynchronous request bound',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});f.send.renewLease(f.time.value+5);
 const pending=f.send(url,request(challenge(),{beforeConnect:()=>new Promise(()=>{})}));t.mock.timers.tick(6);
 await assert.rejects(pending,e=>e.code==='timeout');assert.equal(f.calls.length,0);
 const g=fixture('lark',{waitForOwner:true,deadlineMs:undefined,connect:async(u,p,r)=>JSON.parse(r.body).type==='verification'?{status:200,body:Buffer.from(JSON.stringify({challenge:challenge().challenge}))}:new Promise(()=>{})});
 g.send.renewLease(g.time.value+60000);await g.send(url,request(challenge()));
 const event=g.event();event.data.reply_deadline=new Date(g.time.value+5).toISOString();
 const sending=g.send(url,request(event));await waitFor(()=>g.send.state().event_attempted);t.mock.timers.tick(6);
 await assert.rejects(sending,e=>e.code==='timeout');assert.throws(()=>g.send.renewLease(g.time.value+60000));
});


test('locking an owner message deadline never restarts the ten-second request budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined,connect:async(u,p,r)=>JSON.parse(r.body).type==='verification'?{status:200,body:Buffer.from(JSON.stringify({challenge:challenge().challenge}))}:new Promise(()=>{})});
 f.send.renewLease(f.time.value+60000);await f.send(url,request(challenge()));
 let release;const sending=f.send(url,request(f.event(),{beforeConnect:()=>new Promise(resolve=>{release=resolve;})}));
 await waitFor(()=>release);f.time.value+=9000;t.mock.timers.tick(9000);release();
 await waitFor(()=>f.send.state().event_attempted);t.mock.timers.tick(1001);
 await assert.rejects(sending,e=>e.code==='timeout');
});


test('renewing the same absolute lease cannot reset its monotonic expiry',t=>{
 let monotonic=0;t.mock.method(performance,'now',()=>monotonic);
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined}),expiry=f.time.value+1000;
 f.send.renewLease(expiry);assert.equal(f.send.preflight().ready,true);
 // A stalled or adjusted wall clock does not make the old absolute lease new.
 monotonic=1001;assert.equal(f.send.preflight().ready,false);
 f.send.renewLease(expiry);assert.equal(f.send.preflight().ready,false);
 f.send.renewLease(f.time.value+60000);assert.equal(f.send.preflight().ready,true);
});


test('owner lifecycle status distinguishes awaiting subscription, expiry and close from proxy policy',async()=>{
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined});
 const state=reason=>({ready:false,mode:'blocked',reason,proxy_configured:true,destination_binding:'unverified',network_checked:false});
 assert.deepEqual(f.send.preflight(),state('awaiting_subscription'));assert.equal(f.send.state().expired,false);
 await assert.rejects(f.send(url,request(challenge())),e=>e.code==='aborted');assert.equal(f.calls.length,0);
 f.send.renewLease(f.time.value+1000);assert.equal(f.send.preflight().ready,true);
 f.time.value+=1000;assert.deepEqual(f.send.preflight(),state('scope_expired'));assert.equal(f.send.state().expired,true);
 f.send.renewLease(f.time.value+1000);assert.equal(f.send.preflight().ready,true);
 f.send.close();assert.deepEqual(f.send.preflight(),state('scope_closed'));
 for(const reason of ['awaiting_subscription','scope_expired','scope_closed']){
  assert.deepEqual(projectCallbackTransportStatus(state(reason)),state(reason));
  for(const change of [{ready:true},{proxy_configured:false},{proxy_configured:null},{destination_binding:'direct_pinned'},{network_checked:true},{mode:'owner_single_message_proxy'}])assert.throws(()=>projectCallbackTransportStatus({...state(reason),...change}));
 }
 assert.equal(makeCallbackTransport({proxyEnv:f.env}).preflight().reason,'proxy_policy_unverified');
});


function checkpoint(validUntil,extra={}){return{url,subscription_id:subscription,valid_until:validUntil,challenge_verified:true,event_attempted:false,event_accepted:false,closed:false,...extra};}
test('restored verified subscription performs no challenge or construction I/O and retains the exact event binding',async()=>{
 const saved=checkpoint(Date.now()+60000),f=fixture('lark',{waitForOwner:true,deadlineMs:undefined,restoredState:saved});
 assert.equal(f.calls.length,0);assert.equal(f.send.preflight().ready,true);assert.equal(f.send.state().challenge_attempted,true);assert.equal(f.send.state().challenge_verified,true);
 // Import copies primitive state; changing the caller object cannot rebind it.
 saved.url=url+'/other';saved.subscription_id='sub_'+'f'.repeat(64);saved.valid_until=1;saved.closed=true;
 await assert.rejects(f.send(url,request(challenge())),e=>e.code==='invalid_input');
 await assert.rejects(f.send(url+'/other',request(f.event())),e=>e.code==='host_not_allowed');
 const wrong=request(f.event());wrong.headers['x-mcp-subscription-id']='sub_'+'f'.repeat(64);await assert.rejects(f.send(url,wrong),e=>e.code==='invalid_input');
 await f.send(url,request(f.event()));assert.equal(f.calls.length,1);assert.equal(f.send.state().event_accepted,true);
 await assert.rejects(f.send(url,request(f.event())),e=>e.code==='invalid_input');assert.equal(f.calls.length,1);
});
test('restored event and reply outcomes never replenish callback or renewal budgets',async()=>{
 for(const state of [{event_attempted:true,event_accepted:false},{event_attempted:true,event_accepted:true},{event_attempted:true,event_accepted:true,closed:true},{closed:true}]){
  const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined,restoredState:checkpoint(Date.now()+60000,state)});
  const closed=state.closed===true||(state.event_attempted&&!state.event_accepted);
  assert.equal(f.send.state().closed,!!closed);assert.equal(f.send.preflight().ready,!closed);
  await assert.rejects(f.send(url,request(f.event())));await assert.rejects(f.send(url,request(challenge())));
  assert.throws(()=>f.send.renewLease(f.time.value+3600000));assert.equal(f.calls.length,0);
  f.send.close();assert.equal(f.send.preflight().reason,'scope_closed');
 }
});
test('expired restored waiting remains blocked until authenticated renewal and cannot repeat verification',async()=>{
 const f=fixture('lark',{waitForOwner:true,deadlineMs:undefined,restoredState:checkpoint(Date.now()-1000)});
 assert.equal(f.send.preflight().reason,'scope_expired');await assert.rejects(f.send(url,request(f.event())),e=>e.code==='aborted');
 f.send.renewLease(f.time.value+60000);assert.equal(f.send.preflight().ready,true);
 await assert.rejects(f.send(url,request(challenge())));await f.send(url,request(f.event()));assert.equal(f.calls.length,1);
});
test('restore refuses malformed, unverified, contradictory or extra checkpoint state before any connection',()=>{
 const saved=checkpoint(Date.now()+60000),base={waitForOwner:true,deadlineMs:undefined};
 for(const change of [{challenge_verified:false},{challenge_verified:'true'},{event_attempted:'false'},{event_accepted:true},{closed:'false'},{valid_until:NaN},{valid_until:0},{subscription_id:'sub_short'},{url:'http://127.0.0.1/'},{secret:'synthetic-private'},{body:'synthetic-private'}])assert.throws(()=>fixture('lark',{...base,restoredState:{...saved,...change}}));
 for(const key of Object.keys(saved)){const missing={...saved};delete missing[key];assert.throws(()=>fixture('lark',{...base,restoredState:missing}));}
 assert.throws(()=>fixture('lark',{restoredState:saved}));
 assert.throws(()=>fixture('lark',{...base,restoredState:saved,proxyEnv:{HTTPS_PROXY:'http://proxy.example.test',NO_PROXY:'callback.example.test'}}),e=>e.code==='proxy_unsupported');
});

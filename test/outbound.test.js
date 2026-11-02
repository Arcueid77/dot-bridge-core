import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ChannelStore} from '../channels/store.js';
import {OwnerOutbox,outboundDefinitions,outboundEnabled,validateOutboundArguments,projectOutboundResult,nextOutboundTime} from '../channels/outbound.js';
import {createChannelAdapter} from '../channels/contract.js';
import {registerAdapters} from '../router/registry.js';
import {toolResult} from '../router/common.js';

function fixture(t, options={}) {
  const db=new DatabaseSync(':memory:'), cipher={key:Buffer.alloc(32,71)};
  t.after(()=>db.close());
  let now=Date.parse('2026-11-02T00:00:00Z');const sent=[];
  const settings={channel:'telegram',db,enabled:true,clock:()=>now,available:()=>true,seal:(v,a)=>ChannelStore.prototype.seal.call(cipher,v,a),open:(v,a)=>ChannelStore.prototype.open.call(cipher,v,a),send:async args=>{args.authorize();sent.push(args);},...options};
  const box=new OwnerOutbox(settings);
  return {db,box,sent,settings,time:value=>{now=typeof value==='number'?value:Date.parse(value);}};
}
const once=(overrides={})=>({conversation:'owner',text:'fixture reminder',send_at:'2026-11-02T09:00:00+08:00',timezone:'Asia/Singapore',repeat:'once',until:null,idempotency_key:'fixture-intent',...overrides});
const send=(overrides={})=>({conversation:'owner',text:'fixture immediate',idempotency_key:'fixture-immediate',...overrides});

test('outbound mode is opt-in and cannot be enabled through readiness, OAuth or a proxy experiment',()=>{
  assert.equal(outboundEnabled({}),false);
  const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',DOT_BRIDGE_OUTBOUND:'owner-text'};
  assert.equal(outboundEnabled(env),true);
  for(const patch of [{DOT_BRIDGE_OUTBOUND:'true'},{AUTH_MODE:'oauth'},{TUNNEL_SERVICE_OPERATION:'readiness'},{BRIDGE_MODE:'sites'},{CALLBACK_TRANSPORT_MODE:'owner-scoped-proxy'}])assert.throws(()=>outboundEnabled({...env,...patch}));
});
test('disabled sends are refused; QQ and Weixin advertise a capability check only',async t=>{
  const f=fixture(t,{enabled:false});
  assert.equal(f.box.call('check_telegram_outbound',{}).reason,'disabled');
  assert.throws(()=>f.box.call('send_telegram_message',send()));assert.equal(await f.box.tick(),false);assert.equal(f.sent.length,0);
  for(const c of ['qq','weixin'])assert.deepEqual(outboundDefinitions(c).map(t=>t.name),[`check_${c}_outbound`]);
});
test('owner-only closed contracts reject recipient, group, URL, source message, malformed text and unknown arguments',()=>{
  for(const patch of [{conversation:'group'},{recipient:'other'},{chat_id:'other'},{url:'https://example.com'},{message_id:'old-message'},{text:' '},{text:'\ud800'},{text:'secret\x00'}])assert.throws(()=>validateOutboundArguments('telegram','send_telegram_message',send(patch)));
  assert.throws(()=>validateOutboundArguments('telegram','cancel_telegram_scheduled_message',{outbound_id:'forged',expected_revision:1}));
});
test('immediate proactive message has no source-message dependency and is durably idempotent',async t=>{
  const f=fixture(t),first=f.box.call('send_telegram_message',send());
  assert.equal(first.status,'pending');assert.equal(f.db.prepare('SELECT payload FROM dotbridge_outbound').get().payload.includes('fixture immediate'),false);
  await f.box.tick();assert.equal(f.sent.length,1);assert.equal(Object.hasOwn(f.sent[0],'message'),false);
  assert.equal(f.box.call('send_telegram_message',send()).status,'sent');await f.box.tick();assert.equal(f.sent.length,1);
  assert.throws(()=>f.box.call('send_telegram_message',send({text:'different'})));assert.equal(f.box.call('get_telegram_outbound',{outbound_id:first.outbound_id}).last_status,'sent');
});
test('future schedule survives reopening, never sends early, and deduplicates creation after its time has passed',async t=>{
  const f=fixture(t),saved=f.box.call('schedule_telegram_message',once());await f.box.tick();assert.equal(f.sent.length,0);
  await f.box.close();const reopened=new OwnerOutbox(f.settings);f.time('2026-11-02T01:00:00Z');await reopened.tick();assert.equal(f.sent.length,1);
  assert.equal(reopened.call('schedule_telegram_message',once()).outbound_id,saved.outbound_id);await reopened.tick();assert.equal(f.sent.length,1);
});
test('timezone offsets, calendar dates, explicit recurring ends and future bounds are validated',t=>{
  const f=fixture(t);
  for(const patch of [{send_at:'2026-11-02T09:00:00'},{send_at:'2027-02-30T09:00:00Z'},{send_at:'2026-11-01T09:00:00Z'},{send_at:'2028-01-01T09:00:00Z'},{timezone:'Bad/Timezone'},{timezone:'+08:00'},{repeat:'daily'},{repeat:'once',until:'2026-11-10T00:00:00Z'},{repeat:'daily',until:'2026-11-02T00:30:00Z'}])assert.throws(()=>f.box.call('schedule_telegram_message',once(patch)));
});
test('daily and weekly schedules preserve local clock time; DST gaps skip and overlaps send once',()=>{
  const next=(at,zone,repeat='daily')=>new Date(nextOutboundTime(Date.parse(at),zone,repeat)).toISOString();
  assert.equal(next('2026-11-02T01:00:00Z','Asia/Singapore'),'2026-11-03T01:00:00.000Z');
  assert.equal(next('2026-11-02T01:00:00Z','Asia/Singapore','weekly'),'2026-11-09T01:00:00.000Z');
  assert.equal(next('2026-03-07T07:30:00Z','America/New_York'),'2026-03-09T06:30:00.000Z');
  const overlap=next('2026-10-31T05:30:00Z','America/New_York');assert.equal(overlap,'2026-11-01T05:30:00.000Z');
  assert.equal(next(overlap,'America/New_York'),'2026-11-02T06:30:00.000Z');
});
test('missed schedules do not flood stale reminders after downtime; a bounded next occurrence remains',async t=>{
  const f=fixture(t),saved=f.box.call('schedule_telegram_message',once({repeat:'daily',until:'2026-11-10T01:00:00Z'}));
  f.time('2026-11-05T12:00:00Z');await f.box.tick();const value=f.box.call('get_telegram_outbound',{outbound_id:saved.outbound_id});
  assert.equal(f.sent.length,0);assert.equal(value.last_status,'missed');assert.equal(value.send_at,'2026-11-06T01:00:00.000Z');
  const one=f.box.call('schedule_telegram_message',once({send_at:'2026-11-05T13:00:00Z',idempotency_key:'miss-once'}));f.time('2026-11-06T00:00:00Z');await f.box.tick();assert.equal(f.box.call('get_telegram_outbound',{outbound_id:one.outbound_id}).status,'expired');
});
test('unknown provider result pauses recurring work and remains uncertain across restart and identical retries',async t=>{
  let attempts=0;const f=fixture(t,{send:async()=>{attempts++;throw Error('private provider payload must never be exposed');}});
  const args=once({repeat:'daily',until:'2026-11-10T01:00:00Z'}),saved=f.box.call('schedule_telegram_message',args);
  f.time('2026-11-02T01:00:00Z');await f.box.tick();assert.equal(f.box.call('get_telegram_outbound',{outbound_id:saved.outbound_id}).status,'uncertain');
  const reopened=new OwnerOutbox(f.settings);f.time('2026-11-04T01:00:00Z');await reopened.tick();assert.equal(reopened.call('schedule_telegram_message',args).status,'uncertain');assert.equal(attempts,1);
  assert.equal(JSON.stringify(reopened.call('get_telegram_outbound',{outbound_id:saved.outbound_id})).includes('private provider'),false);
});
test('inflight crash is recovered as uncertain without repeating a provider request',async t=>{
  const f=fixture(t),saved=f.box.call('send_telegram_message',send());f.db.prepare("UPDATE dotbridge_outbound SET state='sending' WHERE id=?").run(saved.outbound_id);
  const reopened=new OwnerOutbox(f.settings);await reopened.tick();const result=reopened.call('get_telegram_outbound',{outbound_id:saved.outbound_id});assert.equal(result.status,'uncertain');assert.equal(result.reason,'recovered_inflight');assert.equal(f.sent.length,0);
});
test('update uses revisions, cancellation is idempotent and neither can reset a send already in progress',async t=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});const f=fixture(t,{send:async()=>wait});
  const saved=f.box.call('schedule_telegram_message',once()),{idempotency_key,...replacement}=once({text:'updated'});
  const edited=f.box.call('update_telegram_scheduled_message',{...replacement,outbound_id:saved.outbound_id,expected_revision:1});assert.equal(edited.revision,2);
  assert.throws(()=>f.box.call('update_telegram_scheduled_message',{...replacement,outbound_id:saved.outbound_id,expected_revision:1}));
  const cancel={outbound_id:saved.outbound_id,expected_revision:2};assert.equal(f.box.call('cancel_telegram_scheduled_message',cancel).status,'cancelled');assert.equal(f.box.call('cancel_telegram_scheduled_message',cancel).revision,3);
  const sending=f.box.call('send_telegram_message',send()),tick=f.box.tick();assert.throws(()=>f.box.call('cancel_telegram_scheduled_message',{outbound_id:sending.outbound_id,expected_revision:1}));
  await f.box.tick();release();await tick;assert.equal(f.box.call('get_telegram_outbound',{outbound_id:sending.outbound_id}).status,'sent');
});
test('retention purges terminal text while preserving stable deduplication; active schedule text survives until it ends',async t=>{
  const f=fixture(t),first=f.box.call('send_telegram_message',send());await f.box.tick();f.box.call('schedule_telegram_message',once({send_at:'2026-12-02T09:00:00+08:00'}));
  f.time('2026-11-10T00:00:00Z');await f.box.tick();assert.equal(f.box.call('get_telegram_outbound',{outbound_id:first.outbound_id}).text,'');assert.equal(f.box.call('send_telegram_message',send()).status,'sent');assert.equal(f.box.call('list_telegram_scheduled_messages',{}).messages[0].text,'fixture reminder');
});
test('new tool schemas and results pass the same closed aggregate adapter, with bounded owner-only projections',t=>{
  const f=fixture(t),adapter=createChannelAdapter({id:'telegram',envPrefix:'TELEGRAM',defaultPort:8794}),[registered]=registerAdapters([adapter]);
  const args=send(),call={name:'send_telegram_message',arguments:args},result=f.box.call(call.name,args);
  assert.deepEqual(registered.validateToolArguments(call.name,args,true),args);assert.deepEqual(registered.projectToolResult(call,toolResult(result),true),result);
  assert.throws(()=>projectOutboundResult('telegram',call,toolResult({...result,recipient:'private-identity'})));
  assert.throws(()=>projectOutboundResult('telegram',call,toolResult({...result,outbound_id:'out_'+'a'.repeat(64)})));
  assert.throws(()=>projectOutboundResult('telegram',call,toolResult({...result,send_at:'invalid-date'})));
  assert.throws(()=>adapter.validateToolArguments(call.name,args,false));
});

test('saved reminders obey their inclusive end date, and provider attempts are bounded to ten per minute',async t=>{
 const f=fixture(t),args=once({repeat:'daily',until:'2026-11-03T01:00:00Z'}),saved=f.box.call('schedule_telegram_message',args);
 f.time('2026-11-02T01:00:00Z');await f.box.tick();assert.equal(f.sent.length,1);assert.equal(f.box.call('get_telegram_outbound',{outbound_id:saved.outbound_id}).status,'active');
 f.time('2026-11-03T01:00:00Z');await f.box.tick();assert.equal(f.sent.length,2);assert.equal(f.box.call('get_telegram_outbound',{outbound_id:saved.outbound_id}).status,'completed');
 for(let n=0;n<12;n++)f.box.call('send_telegram_message',send({idempotency_key:`fixture-rate-${n}`}));
 for(let n=0;n<12;n++)await f.box.tick();assert.equal(f.sent.length,11); // one prior occurrence plus nine new requests in this minute
 f.time('2026-11-03T01:01:01Z');await f.box.tick();assert.equal(f.sent.length,12);
});

test('disabled restart holds saved work without sending; reenabling still skips reminders missed beyond grace',async t=>{
 const f=fixture(t),saved=f.box.call('schedule_telegram_message',once());await f.box.close();
 const disabled=new OwnerOutbox({...f.settings,enabled:false});f.time('2026-11-02T01:01:00Z');await disabled.tick();assert.equal(disabled.call('get_telegram_outbound',{outbound_id:saved.outbound_id}).status,'active');assert.equal(f.sent.length,0);
 f.time('2026-11-02T01:06:00Z');const enabled=new OwnerOutbox(f.settings);await enabled.tick();assert.equal(enabled.call('get_telegram_outbound',{outbound_id:saved.outbound_id}).status,'expired');assert.equal(f.sent.length,0);
});

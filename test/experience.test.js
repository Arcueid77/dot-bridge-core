import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChannelService} from '../channels/service.js';
import {createChannelConfig} from '../channels/config.js';
import {interactionPolicy,conversationRoute} from '../channels/experience-policy.js';
import {privateMkdtempSync,privateMkdirSync,cleanupPrivateFixture,beforeFixtureCleanup} from '../packages/dot-bridge-platform/test-fixtures.js';
import {windowsWritePrivateFile} from '../packages/dot-bridge-platform/index.js';

const channel={id:'fixture',name:'Fixture',envPrefix:'FIXTURE',defaultPort:8799,maxReplyText:20000,experience:{groups:true,streaming:true}};
const group=(conversation_id,other={})=>({conversation_id,members:'all',mention:true,auto_reply:'off',...other});
function fixture(t,policy={}){
  const dir=privateMkdtempSync(path.join(os.tmpdir(),'dot-experience-'));cleanupPrivateFixture(t,dir);
  const write=(name,value)=>{const file=path.join(dir,name);if(process.platform==='win32')windowsWritePrivateFile(file,Buffer.from(value));else fs.writeFileSync(file,value,{mode:0o600});return file;};
  const locks=path.join(dir,'locks');privateMkdirSync(locks,{mode:0o700});
  const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',TUNNEL_SERVICE_KEY_FILE:write('service.key',Buffer.alloc(32,31).toString('base64url')),CALLBACK_TRANSPORT_MODE:'standard',CALLBACK_HOSTS:'callback.example.com',FIXTURE_CREDENTIALS_FILE:write('credentials.json',JSON.stringify({ownerId:'owner',conversationId:'dm',botToken:'synthetic'})),STORAGE_KEY_FILE:write('storage.key',Buffer.alloc(32,32).toString('base64')),DATABASE_PATH:path.join(dir,'bridge.sqlite'),BRIDGE_LOCK_DIRECTORY:locks,DOT_BRIDGE_INTERACTION_POLICY_FILE:write('interaction.json',JSON.stringify({version:1,...policy}))};
  const config=createChannelConfig(channel,env),events=[],calls=[],progress=[],feedback=[];
  const transport=async(_url,{body,beforeConnect})=>{beforeConnect();const value=JSON.parse(body);if(value.type==='verification')return {status:200,body:Buffer.from(JSON.stringify({challenge:value.challenge}))};events.push(value);return {status:200,body:Buffer.from('{}')};};
  transport.preflight=()=>({ready:true});
  let service;
  const open=(overrides={})=>service=new ChannelService(config,{transport,createProvider:()=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async value=>{value.authorize();calls.push(value);},setFeedback:async value=>{value.authorize();feedback.push(value.active);return 'private-reaction-ref';},setTyping:async()=>{},sendProgress:async value=>{value.authorize();progress.push(value);return value.reference??{id:'private-native-message'};},finishProgress:async()=>{},...overrides})});
  beforeFixtureCleanup(t,async()=>{if(service&&!service.closed)await service.close();});
  return {config,events,calls,progress,feedback,open};
}
const owner=(id,text='hello')=>({id,senderId:'owner',conversationId:'dm',text,replyContext:{messageId:id}});
const message=(id,chat='group-a',other={})=>({id,senderId:'member',conversationId:chat,text:'hello group',chatType:'group',botMentioned:true,replyContext:{messageId:id},...other});
const sub=(scope='owner')=>({name:'fixture.message.created',arguments:{conversation:scope},delivery:{mode:'webhook',url:'https://callback.example.com/current-dot',secret:'whsec_'+Buffer.alloc(32,33).toString('base64')},ttlMs:600000});
const settle=async service=>{await service.working;await service.drain();};

test('processing feedback does not make a final-delivery precheck suppress the only reply',async t=>{
  const f=fixture(t,{feedback:{enabled:true}}),service=f.open();await service.subscribe(sub());
  const id=await service.ingest(owner('delivery-precheck'));await settle(service);
  const source=service.call('get_fixture_message',{message_id:id});assert.equal(source.reply_status,'none');
  assert.equal(service.experience.status(service.store.message(id)).status,'processing');
  const delivery=service.call('get_fixture_reply_status',{message_id:id});
  assert.equal(delivery.status,'none','typing/processing feedback must not claim that the final reply is already being sent');
  if(delivery.status==='none')service.call('reply_to_fixture',{message_id:id,text:'one final answer',idempotency_key:'one-final-answer'});
  await settle(service);assert.equal(f.calls.length,1);assert.equal(service.call('get_fixture_reply_status',{message_id:id}).status,'sent');
});

test('protected policy rejects unused allowlists and groups default to disabled',()=>{
  const config={channel,credentials:{ownerId:'owner',conversationId:'dm'},interaction:interactionPolicy({},channel)};
  assert.equal(conversationRoute(config,message('1')),undefined);
  assert.throws(()=>interactionPolicy({groups:[group('a',{members:'allowlist'})]},channel));
  assert.throws(()=>interactionPolicy({groups:[group('a',{allow_from:['member']})]},channel));
  assert.throws(()=>interactionPolicy({groups:[group('a',{auto_reply:'keywords'})]},channel));
});

test('owner subscription never receives configured groups and existing owner references are stable',async t=>{
  const f=fixture(t,{groups:[group('group-a')]}),service=f.open();await service.subscribe(sub());
  const first=await service.ingest(owner('same'));const grouped=await service.ingest(message('same'));
  assert.notEqual(first,grouped);await settle(service);assert.equal(f.events.length,1);assert.equal(f.events[0].data.conversation,'owner');
  assert.throws(()=>service.call('get_fixture_message',{message_id:grouped}));assert.equal(service.setup().pending_messages.length,1);
});

test('group contexts isolate conversations, topics and members; real mentions and configured triggers are required',async t=>{
  const f=fixture(t,{groups:[group('group-a'),group('group-b',{members:'allowlist',allow_from:['member'],mention:false,auto_reply:'keywords',keywords:['please']})]}),service=f.open();await service.subscribe(sub('configured'));
  assert.equal(await service.ingest(message('bad','group-a',{botMentioned:false})),false);
  assert.equal(await service.ingest(message('bad','group-b',{senderId:'stranger',text:'please'})),false);
  const first=await service.ingest(message('1','group-a',{threadId:'topic-a',text:'same sender context'}));await settle(service);
  await service.ingest(message('2','group-a',{threadId:'topic-b',text:'other topic'}));
  await service.ingest(message('3','group-a',{threadId:'topic-a',senderId:'another',text:'other sender'}));
  await service.ingest(message('4','group-b',{text:'please keep other group isolated'}));
  const last=await service.ingest(message('5','group-a',{threadId:'topic-a'}));await settle(service);
  const context=service.call('get_fixture_context',{message_id:last});assert.equal(context.messages.length,1);assert.equal(context.messages[0].message_id,first);assert.equal(context.messages[0].text,'same sender context');
  assert.equal(f.events.filter(value=>value.data.conversation==='configured').length,5);
});

test('management replies work without a model subscription, do not dispatch events and deduplicate commands',async t=>{
  const f=fixture(t),service=f.open();const id=await service.ingest(owner('status','/status'));await settle(service);
  assert.equal(f.events.length,0);assert.equal(f.calls.length,1);assert.match(f.calls[0].text,/subscription: none/);
  assert.equal(await service.ingest(owner('status','/status')),false);await settle(service);assert.equal(f.calls.length,1);
  assert.equal(service.store.message(id).reply_state,'sent');
});

test('owner cancellation preserves unknown and inflight deliveries and only cancels the current pending reply',async t=>{
  const f=fixture(t),service=f.open();await service.subscribe(sub());
  const first=await service.ingest(owner('1'));await settle(service);
  const unknown=await service.ingest(owner('2'));await settle(service);service.store.db.prepare("UPDATE channel_messages SET reply_state='uncertain' WHERE id=?").run(unknown);
  await service.ingest(owner('cancel','/cancel'));await settle(service);
  assert.equal(service.store.message(first).reply_state,'cancelled');assert.equal(service.store.message(unknown).reply_state,'uncertain');assert.throws(()=>service.call('reply_to_fixture',{message_id:first,text:'late answer',idempotency_key:'late'}));
  assert.match(f.calls.at(-1).text,/Bridge reply cancelled/);
});

test('genuine progress is monotonic and finalizes the same native message; uncertain creation is not replayed',async t=>{
  const f=fixture(t,{feedback:{enabled:true}});let service=f.open();await service.subscribe(sub());
  const id=await service.ingest(owner('1'));await settle(service);service.call('begin_fixture_reply',{message_id:id});
  service.call('append_fixture_reply',{message_id:id,sequence:1,text:'first part'});await settle(service);
  assert.throws(()=>service.call('append_fixture_reply',{message_id:id,sequence:2,text:'replaced text'}));
  service.call('append_fixture_reply',{message_id:id,sequence:1,text:'first part'});await settle(service);assert.equal(f.progress.length,1);
  await service.close();service=f.open();service.call('reply_to_fixture',{message_id:id,text:'first part and final answer',idempotency_key:'final'});await settle(service);
  assert.equal(f.calls.length,0);assert.equal(f.progress.length,2);assert.equal(f.progress[1].final,true);assert.deepEqual(f.progress[1].reference,{id:'private-native-message'});assert.equal(service.store.message(id).reply_state,'sent');
  const second=await service.ingest(owner('2'));await settle(service);service.provider.sendProgress=async()=>{throw Error('ambiguous native send');};service.call('begin_fixture_reply',{message_id:second});service.call('append_fixture_reply',{message_id:second,sequence:1,text:'unknown part'});await settle(service);
  assert.equal(service.call('get_fixture_reply_status',{message_id:second}).status,'uncertain');
  assert.equal(service.call('reply_to_fixture',{message_id:second,text:'unknown part final',idempotency_key:'no-replay'}).status,'uncertain');await settle(service);assert.equal(f.calls.length,0);
});

test('progress acknowledgements do not overwrite newer generated frames while network work is inflight',async t=>{
  const f=fixture(t,{feedback:{enabled:true}}),service=f.open();await service.subscribe(sub());const id=await service.ingest(owner('1'));await settle(service);service.call('begin_fixture_reply',{message_id:id});
  let acknowledge;service.provider.sendProgress=()=>new Promise(resolve=>{acknowledge=resolve;});
  service.call('append_fixture_reply',{message_id:id,sequence:1,text:'one'});await new Promise(resolve=>setImmediate(resolve));
  service.call('append_fixture_reply',{message_id:id,sequence:2,text:'one two'});acknowledge({id:'native'});await service.working;
  const state=service.experience.get(id);assert.equal(state.sequence,2);assert.equal(state.text,'one two');assert.equal(state.appliedSequence,1);
  service.provider.sendProgress=async()=>({id:'native'});await settle(service);assert.equal(service.experience.get(id).appliedSequence,2);
});

test('a configured long reply persists each acknowledged native part and preserves an ambiguous remainder across restart',async t=>{
  const f=fixture(t,{replies:{long_text:'chunks'}}),sent=[];
  const provider={planTextReply:()=>[{text:'part one',format:'text'},{text:'part two',format:'text'}],sendTextPart:async part=>{part.authorize();sent.push(part.ordinal);if(part.ordinal===1)throw Error('unknown second-part outcome');}};
  let service=f.open(provider);await service.subscribe(sub());const id=await service.ingest(owner('parts'));await settle(service);
  const args={message_id:id,text:'approved complete answer',idempotency_key:'parts-final'};service.call('reply_to_fixture',args);await settle(service);
  assert.deepEqual(sent,[0,1]);assert.equal(service.store.message(id).reply_state,'uncertain');
  assert.deepEqual(service.store.db.prepare('SELECT state FROM channel_reply_parts WHERE message_id=? ORDER BY ordinal').all(id).map(row=>row.state),['sent','uncertain']);
  await service.close();service=f.open(provider);assert.equal(service.call('reply_to_fixture',args).status,'uncertain');await settle(service);assert.deepEqual(sent,[0,1]);
  const raw=fs.readFileSync(f.config.dbPath).toString('latin1');assert.equal(raw.includes('part one'),false);assert.equal(raw.includes('approved complete answer'),false);
});

test('forwarded text is never interpreted as an owner management action',async t=>{
  const f=fixture(t),service=f.open();await service.subscribe(sub());const id=await service.ingest({...owner('forwarded','/status'),forwarded:true});await settle(service);
  assert.equal(f.events.length,1);assert.equal(f.calls.length,0);assert.equal(service.management.marked(id),false);
});


test('a lost final acknowledgement preserves the native reply and never deletes or replays it',async t=>{
  const f=fixture(t,{feedback:{enabled:true}});let deleted=0;const service=f.open({finishProgress:async()=>{deleted++;}});await service.subscribe(sub());
  const id=await service.ingest(owner('final-unknown'));await settle(service);service.call('begin_fixture_reply',{message_id:id});service.call('append_fixture_reply',{message_id:id,sequence:1,text:'generated'});await settle(service);
  service.provider.sendProgress=async()=>{throw Error('final acknowledgement lost');};service.call('reply_to_fixture',{message_id:id,text:'generated final',idempotency_key:'unknown-final'});await settle(service);await settle(service);
  assert.equal(service.store.message(id).reply_state,'uncertain');assert.equal(service.experience.get(id).streamState,'uncertain');assert.equal(service.store.db.prepare('SELECT inflight FROM channel_experience WHERE message_id=?').get(id).inflight,0);assert.equal(deleted,0);assert.equal(f.calls.length,0);
});

test('context is bounded by accepted order even when several messages share one clock tick',async t=>{
  const f=fixture(t),service=f.open();service.clock=()=>1700000000000;await service.subscribe(sub());
  const first=await service.ingest(owner('first','preceding'));const anchor=await service.ingest(owner('anchor','anchor'));await service.ingest(owner('later','future to anchor'));await settle(service);
  assert.deepEqual(service.call('get_fixture_context',{message_id:anchor}).messages.map(value=>value.message_id),[first]);
});

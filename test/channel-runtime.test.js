import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {ChannelService} from '../channels/service.js';
import {createChannelConfig} from '../channels/config.js';
import {createChannelAdapter} from '../channels/contract.js';
import {channelLock} from '../channels/lock.js';
import {channelServer,webhookServer} from '../channels/server.js';
import {createApp} from '../router/server.js';
import {OWNER,VERSION,metadata} from '../router/common.js';
import {privateMkdtempSync,privateMkdirSync,cleanupPrivateFixture,beforeFixtureCleanup} from '../packages/dot-bridge-platform/test-fixtures.js';
import {windowsWritePrivateFile} from '../packages/dot-bridge-platform/index.js';
import {RICH_TOOL_RESULT} from '../router/common.js';
import {MAX_MEDIA_BYTES,MEDIA_RPC_LIMIT,attachmentResult} from '../channels/media.js';
import {toolResult,rpcResult} from '../router/common.js';

const channel={id:'fixture',name:'Synthetic fixture',envPrefix:'FIXTURE',defaultPort:8799,maxReplyText:100};
function fixture(t){
 const directory=privateMkdtempSync(path.join(os.tmpdir(),'dot-channel-test-'));cleanupPrivateFixture(t,directory);
 const write=(name,value)=>{const file=path.join(directory,name);if(process.platform==='win32')windowsWritePrivateFile(file,Buffer.from(value));else fs.writeFileSync(file,value,{mode:0o600});return file;};
 const keys=[write('backend.key',Buffer.alloc(32,61).toString('base64url')),write('router.key',Buffer.alloc(32,62).toString('base64url'))];
 const locks=path.join(directory,'locks');privateMkdirSync(locks,{mode:0o700});
 const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',TUNNEL_SERVICE_OWNER_ID:OWNER,TUNNEL_SERVICE_KEY_FILE:keys[0],PORT:'8799',CALLBACK_TRANSPORT_MODE:'standard',CALLBACK_HOSTS:'callback.example.com',FIXTURE_CREDENTIALS_FILE:write('provider.json',JSON.stringify({ownerId:'fixture-owner',conversationId:'fixture-chat',botToken:'fixture-secret'})),STORAGE_KEY_FILE:write('storage.key',Buffer.alloc(32,63).toString('base64')),DATABASE_PATH:path.join(directory,'channel.sqlite'),BRIDGE_LOCK_DIRECTORY:locks};
 return {directory,env,keys,write,config:()=>createChannelConfig(channel,env)};
}
function transportFixture(){
 const events=[];let failEvent=false;
 const send=async(_url,{body,headers,beforeConnect})=>{
  beforeConnect();const value=JSON.parse(body.toString('utf8'));const key=Buffer.alloc(32,64),expected='v1,'+createHmac('sha256',key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.`).update(body).digest('base64');assert.equal(headers['webhook-signature'],expected);
  if(value.type==='verification')return {status:200,body:Buffer.from(JSON.stringify({challenge:value.challenge}))};
  events.push(value);if(failEvent)throw Error('Synthetic callback timeout');return {status:200,body:Buffer.from('{}')};
 };
 send.preflight=()=>({ready:true,mode:'direct',reason:'none',proxy_configured:false,destination_binding:'direct_pinned',network_checked:false});
 return {send,events,fail:()=>{failEvent=true;}};
}
const subscription=()=>({name:'fixture.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://callback.example.com/from-current-dot',secret:'whsec_'+Buffer.alloc(32,64).toString('base64')},ttlMs:600000});
function serviceFixture(t,f,{failReply=false,transport=transportFixture()}={}){
 const calls=[];const service=new ChannelService(f.config(),{transport:transport.send,createProvider:({onMessage,state})=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async args=>{calls.push(args);if(failReply)throw Error('Uncertain fixture send');},onMessage,state})});
 beforeFixtureCleanup(t,()=>service.close());return {service,calls,transport};
}
const incoming=(id='fixture-1')=>({id,senderId:'fixture-owner',conversationId:'fixture-chat',text:'private synthetic message',replyContext:{secret:'private-session-token'}});
const settle=async service=>{await service.working;await service.drain();};
function rpc(port,key,method,params={}){
 const body=JSON.stringify({jsonrpc:'2.0',id:'fixture',method,params:{...params,_meta:metadata()}});
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{host:`127.0.0.1:${port}`,'content-type':'application/json',accept:'application/json,text/event-stream','content-length':Buffer.byteLength(body),'mcp-protocol-version':VERSION,'mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{}),'x-dot-bridge-service-key':key}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(body);});
}

test('shared channel authorizes owner, verifies signed current-dot callback and persists exactly one reply',async t=>{
 const f=fixture(t),{service,calls,transport}=serviceFixture(t,f);await service.subscribe(subscription());
 assert.equal(await service.ingest({...incoming(),senderId:'someone-else'}),false);
 const id=await service.ingest(incoming());assert.ok(id);assert.equal(await service.ingest(incoming()),false);await settle(service);
 assert.equal(transport.events.length,1);assert.equal(transport.events[0].data.message_id,id);assert.equal(transport.events[0].data.text,'private synthetic message');
 assert.equal(JSON.stringify(transport.events).includes('private-session-token'),false);
 const args={message_id:id,text:'fixture answer',idempotency_key:'stable-fixture-key'};
 service.call('reply_to_fixture',args);await settle(service);service.call('reply_to_fixture',args);await settle(service);
 assert.equal(calls.length,1);assert.equal(calls[0].message.conversationId,'fixture-chat');assert.ok(calls[0].message.replyDeadline>Date.now());assert.equal(service.call('get_fixture_reply_status',{message_id:id}).status,'sent');
 assert.throws(()=>service.call('reply_to_fixture',{...args,text:'different reply'}));
 assert.throws(()=>service.call('reply_to_fixture',{...args,recipient:'arbitrary-recipient'}));
});

test('uncertain reply and callback sends are retained and never retried after reopening SQLite',async t=>{
 const f=fixture(t),transport=transportFixture();transport.fail();const first=serviceFixture(t,f,{failReply:true,transport});await first.service.subscribe(subscription());
 const id=await first.service.ingest(incoming());await settle(first.service);assert.equal(first.service.store.message(id).event_state,'uncertain');
 first.service.call('reply_to_fixture',{message_id:id,text:'fixture',idempotency_key:'once'});await settle(first.service);assert.equal(first.calls.length,1);assert.equal(first.service.store.message(id).reply_state,'uncertain');
 await first.service.close();const second=serviceFixture(t,f);await settle(second.service);
 assert.equal(second.calls.length,0);assert.equal(second.transport.events.length,0);assert.equal(second.service.call('get_fixture_reply_status',{message_id:id}).status,'uncertain');
 assert.equal(await second.service.ingest(incoming()),false);
});

test('explicit transient callback response is retried finitely with the same event ID; control text cannot poison the cursor',async t=>{
 const f=fixture(t),transport=transportFixture(),base=transport.send;let attempts=0;const ids=[];
 transport.send=async(url,options)=>{const value=JSON.parse(options.body);if(value.type==='verification')return base(url,options);ids.push(value.eventId);attempts++;if(attempts===1)return {status:503,body:Buffer.from('{}')};return base(url,options);};transport.send.preflight=base.preflight;
 const {service}=serviceFixture(t,f,{transport});let now=Date.now();service.clock=()=>now;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),text:'safe\u0000text\ud800'});await settle(service);assert.equal(attempts,1);assert.equal(service.store.message(id).event_state,'pending');
 now+=2000;await service.drain();assert.equal(attempts,2);assert.equal(ids[0],ids[1]);assert.equal(service.store.message(id).event_state,'delivered');assert.equal(service.call('get_fixture_message',{message_id:id}).text,'safe\ufffdtext\ufffd');
});

test('private SQLite state encrypts message, cursor, callback and reply context and refuses identity/key changes',async t=>{
 const f=fixture(t),{service}=serviceFixture(t,f);service.provider.state.set('cursor',{token:'private-cursor-token'});await service.subscribe(subscription());await service.ingest(incoming());await settle(service);await service.close();
 const data=fs.readFileSync(f.env.DATABASE_PATH).toString('latin1');for(const secret of ['private synthetic message','private-session-token','private-cursor-token','callback.example.com','fixture-owner'])assert.equal(data.includes(secret),false);
 const config=f.config();assert.throws(()=>new ChannelService({...config,credentials:{...config.credentials,ownerId:'new-owner'}},{createProvider:()=>{}}));
 assert.throws(()=>new ChannelService({...config,storageKey:Buffer.alloc(32,66).toString('base64')},{createProvider:()=>{}}));
});

test('callback policy, one subscription, unsubscribe generation and pending inbox survive restarts safely',async t=>{
 const f=fixture(t),{service,transport}=serviceFixture(t,f);const id=await service.ingest(incoming());assert.equal(transport.events.length,0);
 await assert.rejects(service.subscribe({...subscription(),delivery:{...subscription().delivery,url:'https://unapproved.example.com/receiver'}}),e=>e.data?.reason==='callback_policy_required');
 await service.subscribe(subscription());await settle(service);assert.equal(transport.events.length,1);
 await assert.rejects(service.subscribe({...subscription(),delivery:{...subscription().delivery,url:'https://callback.example.com/another-dot'}}));
 const {secret,...delivery}=subscription().delivery;service.unsubscribe({name:subscription().name,arguments:{conversation:'owner'},delivery});
 assert.throws(()=>service.call('reply_to_fixture',{message_id:id,text:'revoked',idempotency_key:'revoked'}));
 await service.subscribe(subscription());await settle(service);assert.equal(transport.events.length,1);assert.throws(()=>service.call('get_fixture_message',{message_id:id}));
});

test('single-host mode lock fences duplicate consumers and readiness loads no provider configuration',async t=>{
 const f=fixture(t),config=f.config();const release=await channelLock(config);try{await assert.rejects(async()=>channelLock(config));}finally{await release();}
 const release2=await channelLock(config);await release2();
 const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'readiness',TUNNEL_SERVICE_OWNER_ID:OWNER,TUNNEL_SERVICE_KEY_FILE:f.keys[0],FIXTURE_TRANSPORT:'disabled'};
 assert.equal(createChannelConfig(channel,env).operation,'readiness');assert.throws(()=>createChannelConfig(channel,{...env,FIXTURE_CREDENTIALS_FILE:'not-read-in-readiness'}));
});

test('new channel integrates through real authenticated router tool/event catalogs and projects results',async t=>{
 const f=fixture(t),{service}=serviceFixture(t,f),backend=channelServer(f.config(),service);const address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter:createChannelAdapter(channel),port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());const key=fs.readFileSync(f.keys[1],'utf8');
 const catalog=await rpc(route.port,key,'tools/list');assert.equal(catalog.status,200);assert.equal(catalog.body.result.tools.length,6);
 assert.ok(catalog.body.result.tools.some(tool=>tool.name==='check_fixture_outbound'));
 assert.equal((await rpc(route.port,key,'events/list')).body.result.events[0].name,'fixture.message.created');
 const setup=await rpc(route.port,key,'tools/call',{name:'check_fixture_readiness',arguments:{}});assert.equal(setup.status,200);assert.equal(setup.body.result.structuredContent.binding_ready,true);
 assert.equal((await rpc(route.port,'invalid','tools/list')).status,401);
 const subscribed=await rpc(route.port,key,'events/subscribe',subscription());assert.match(subscribed.body.result.id,/^sub_/);
 const id=await service.ingest(incoming());await settle(service);const msg=await rpc(route.port,key,'tools/call',{name:'get_fixture_message',arguments:{message_id:id}});assert.equal(msg.body.result.structuredContent.text,'private synthetic message');
});

test('a saved future owner message crosses authenticated router and persists independently of an incoming subscription',async t=>{
 const f=fixture(t),calls=[],c={...channel,id:'telegram',envPrefix:'TELEGRAM'},config={...f.config(),channel:c,outboundEnabled:true};
 let now=Date.parse('2026-11-02T00:00:00Z');
 const service=new ChannelService(config,{clock:()=>now,createProvider:()=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async()=>{},sendOwnerMessage:async args=>{args.authorize();calls.push(args);}})});
 beforeFixtureCleanup(t,()=>service.close());
 const backend=channelServer(config,service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['telegram'],ingressKeyFile:f.keys[1],channels:{telegram:{adapter:createChannelAdapter(c),port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());const key=fs.readFileSync(f.keys[1],'utf8');
 const args={conversation:'owner',text:'fixture future notification',send_at:'2026-11-02T09:00:00+08:00',timezone:'Asia/Singapore',repeat:'once',until:null,idempotency_key:'fixture-saved-reminder'};
 const queued=await rpc(route.port,key,'tools/call',{name:'schedule_telegram_message',arguments:args});assert.equal(queued.status,200);
 const saved=queued.body.result.structuredContent;assert.equal(saved.status,'active');assert.match(saved.outbound_id,/^out_/);await settle(service);assert.equal(calls.length,0);assert.equal(service.subscription(),undefined);
 const readonly=await rpc(route.port,key,'tools/call',{name:'check_telegram_outbound',arguments:{}});assert.equal(readonly.body.result.structuredContent.enabled,true);
 now+=3600000;await settle(service);assert.equal(calls.length,1);assert.equal(calls[0].text,args.text);assert.equal(Object.hasOwn(calls[0],'message'),false);
 const result=await rpc(route.port,key,'tools/call',{name:'get_telegram_outbound',arguments:{outbound_id:saved.outbound_id}});assert.equal(result.body.result.structuredContent.status,'sent');
 const again=await rpc(route.port,key,'tools/call',{name:'schedule_telegram_message',arguments:args});assert.equal(again.body.result.structuredContent.outbound_id,saved.outbound_id);await settle(service);assert.equal(calls.length,1);
 const rejected=await rpc(route.port,key,'tools/call',{name:'schedule_telegram_message',arguments:{...args,recipient:'other'}});assert.ok(rejected.body.error);
});

test('dedicated loopback webhook forwards bounded raw bytes only to signature-verifying provider',async t=>{
 const f=fixture(t),seen=[];const app=webhookServer({...f.config(),webhookPort:8895},{handleWebhook:async input=>{seen.push(input);return {status:input.headers['x-test-signature']==='valid'?200:401,body:''};}});const address=await app.listen(0);beforeFixtureCleanup(t,()=>app.close());
 const request=signature=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:address.port,path:'/webhook',method:'POST',headers:{'content-type':'application/json','x-test-signature':signature}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{"synthetic":true}');});
 assert.equal(await request('valid'),200);assert.equal(await request('invalid'),401);assert.equal(Buffer.isBuffer(seen[0].body),true);
});

const mediaChannel={...channel,media:{read:['image','audio','file'],reply:['image','audio','file']},maxMediaReplyText:20};

test('maximum rich audio and UTF-8 transcript fit the routed response limit',()=>{
 const value={message_id:'msg_fixture',attachment_index:0,kind:'audio',name:'voice.wav',mime_type:'audio/wav',size:MAX_MEDIA_BYTES,extraction_status:'complete',extracted_text:'文'.repeat(12000)};
 const response=rpcResult('fixture',toolResult(attachmentResult(value,Buffer.alloc(MAX_MEDIA_BYTES))));
 assert.ok(Buffer.byteLength(JSON.stringify(response))<MEDIA_RPC_LIMIT);
});

test('a generated attachment is uploaded through the real authenticated router and queued once',async t=>{
 const f=mediaFixture(t),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest(incoming('upload-source'));await settle(service);
 const backend=channelServer(f.config,service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter:createChannelAdapter(mediaChannel),port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());const key=fs.readFileSync(f.keys[1],'utf8');
 const {createHash}=await import('node:crypto');const bytes=Buffer.alloc(200000,65);
 const call=(name,args)=>rpc(route.port,key,'tools/call',{name,arguments:args});
 const begin=await call('begin_fixture_attachment_upload',{message_id:id,type:'file',name:'generated.txt',mime_type:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),idempotency_key:'generated-one'});
 assert.equal(begin.status,200);const upload=begin.body.result.structuredContent.upload_id;
 assert.equal((await call('append_fixture_attachment_upload',{upload_id:upload,offset:0,data:bytes.toString('base64')})).status,200);
 assert.equal((await call('finish_fixture_attachment_upload',{upload_id:upload})).body.result.structuredContent.complete,true);
 const reply={message_id:id,upload_id:upload,idempotency_key:'one-final'};
 assert.equal((await call('reply_fixture_uploaded_attachment',reply)).status,200);await settle(service);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].media.data,bytes);
 assert.equal((await call('reply_fixture_uploaded_attachment',reply)).body.result.structuredContent.status,'sent');await settle(service);assert.equal(f.calls.length,1);
});
function mediaFixture(t,{read,send,validate,transcribe}={}){
 const f=fixture(t),config={...f.config(),channel:mediaChannel},calls=[];
 const service=new ChannelService(config,{transport:transportFixture().send,transcribe,createProvider:()=>({
  start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async()=>{},
  readAttachment:read??(async()=>({data:Buffer.from('private fixture file'),mimeType:'text/plain',name:'note.txt'})),
  validateMediaReply:validate??(()=>{}),sendMediaReply:send??(async args=>{calls.push({...args,media:{...args.media,data:Buffer.from(args.media.data)}});})
 })});beforeFixtureCleanup(t,()=>service.close());return {...f,config,service,calls};
}
test('source attachment replies cross the router once and persist bytes without a model Base64 round trip',async t=>{
 let reads=0;const source=Buffer.from('reusable source file');
 const f=mediaFixture(t,{read:async input=>{assert.equal(input.forReply,true);reads++;return {data:Buffer.from(source),mimeType:'text/plain',name:'note.txt'};}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'file',name:'note.txt'}],replyContext:{downloadToken:'never-export-private-reference'}});await settle(service);
 const backend=channelServer(f.config,service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const adapter=createChannelAdapter(mediaChannel),router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter,port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());
 const args={message_id:id,attachment_index:0,idempotency_key:'source-once'};
 const response=await rpc(route.port,fs.readFileSync(f.keys[1],'utf8'),'tools/call',{name:'reply_fixture_attachment',arguments:args});
 assert.equal(response.status,200);await settle(service);
 assert.equal(reads,1);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].media.data,source);
 assert.equal(f.calls[0].message.conversationId,'fixture-chat');assert.equal(JSON.stringify(response).includes('never-export-private-reference'),false);
 assert.equal((await service.call('reply_fixture_attachment',{...args,type:'file'})).status,'sent');await settle(service);
 assert.equal(reads,1);assert.equal(f.calls.length,1);
 assert.throws(()=>service.call('reply_fixture_attachment',{...args,idempotency_key:'different'}));
 assert.throws(()=>service.call('reply_fixture_media',{message_id:id,type:'file',data:source.toString('base64'),mime_type:'text/plain',name:'note.txt',idempotency_key:'source-once'}));
});

test('source attachment replies refuse foreign fields, unavailable kinds and revocation during the read',async t=>{
 let finish,reads=0;const bytes=Buffer.from('private source');
 const f=mediaFixture(t,{read:()=>{reads++;return new Promise(resolve=>{finish=()=>resolve({data:bytes,mimeType:'text/plain',name:'a.txt'});});}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'file'},{kind:'video'}]});await settle(service);
 const args={message_id:id,attachment_index:0,idempotency_key:'bound-source'};
 for(const change of [{recipient:'other'},{url:'https://untrusted.example.com/a'},{source_message_id:'other'},{attachment_index:9},{attachment_index:1},{message_id:'unavailable'}])assert.throws(()=>service.call('reply_fixture_attachment',{...args,...change}));
 assert.equal(reads,0);
 const reading=service.call('reply_fixture_attachment',args);
 assert.throws(()=>service.call('get_fixture_attachment',{message_id:id,attachment_index:0}));
 const {secret,...delivery}=subscription().delivery;service.unsubscribe({name:subscription().name,arguments:{conversation:'owner'},delivery});finish();
 await assert.rejects(reading);assert.equal(service.store.message(id).reply_state,'cancelled');assert.equal(bytes.every(n=>n===0),true);assert.equal(f.calls.length,0);
});

test('source audio is never transcribed or silently downgraded when it is being forwarded',async t=>{
 let transcriptions=0;
 const f=mediaFixture(t,{read:async()=>({data:Buffer.from('source-audio'),mimeType:'audio/unsupported',name:'voice.bin'}),transcribe:async()=>{transcriptions++;},validate:({media})=>{if(media.type==='audio')throw Error('unsupported audio');}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'audio'}]});await settle(service);
 const args={message_id:id,attachment_index:0,idempotency_key:'audio-source'};
 await assert.rejects(service.call('reply_fixture_attachment',args));assert.equal(service.store.message(id).reply_state,'none');assert.equal(f.calls.length,0);
 await service.call('reply_fixture_attachment',{...args,type:'file'});await settle(service);
 assert.equal(transcriptions,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].media.type,'file');
});

test('uncertain source media survives restart and identical retries never download or send again',async t=>{
 const f=mediaFixture(t,{send:async()=>{throw Error('uncertain provider acknowledgement');}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'file'}]});await settle(service);
 const args={message_id:id,attachment_index:0,idempotency_key:'persisted-source'};
 await service.call('reply_fixture_attachment',args);await settle(service);assert.equal(service.store.message(id).reply_state,'uncertain');await service.close();
 let reads=0,sends=0;
 const next=new ChannelService(f.config,{transport:transportFixture().send,createProvider:()=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async()=>{sends++;},readAttachment:async()=>{reads++;throw Error('must not read again');},sendMediaReply:async()=>{sends++;}})});beforeFixtureCleanup(t,()=>next.close());
 await settle(next);assert.equal((await next.call('reply_fixture_attachment',args)).status,'uncertain');await settle(next);
 assert.equal(reads,0);assert.equal(sends,0);
});

test('text file excerpts report truncation across the router while retaining the complete original bytes',async t=>{
 const source='a'.repeat(11999)+'🙂'+'z'.repeat(1000);
 const f=mediaFixture(t,{read:async()=>({data:Buffer.from(source),mimeType:'text/plain',name:'note.txt'})}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'file'}]});await settle(service);
 const result=toolResult(await service.call('get_fixture_attachment',{message_id:id,attachment_index:0}));
 assert.equal(result.structuredContent.extraction_status,'truncated');assert.equal(result.structuredContent.extracted_text,'a'.repeat(11999));
 const projected=createChannelAdapter(mediaChannel).projectToolResult({name:'get_fixture_attachment',arguments:{message_id:id,attachment_index:0}},result,true);
 assert.equal(projected[RICH_TOOL_RESULT],true);assert.equal(Buffer.from(projected.content[1].resource.blob,'base64').toString(),source);
});

test('binary attachment and a large single media reply cross the authenticated router without leaking private refs',async t=>{
 const f=mediaFixture(t),{service}=f;await service.subscribe(subscription());
 const id=await service.ingest({...incoming(),attachments:[{kind:'file',name:'note.txt'}],replyContext:{downloadToken:'never-export-private-token'}});await settle(service);
 const backend=channelServer(f.config,service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const adapter=createChannelAdapter(mediaChannel),router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter,port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());const key=fs.readFileSync(f.keys[1],'utf8');
 const result=await rpc(route.port,key,'tools/call',{name:'get_fixture_attachment',arguments:{message_id:id,attachment_index:0}});
 assert.equal(result.status,200);assert.equal(result.body.result.structuredContent.size,20);
 assert.equal(Buffer.from(result.body.result.content[1].resource.blob,'base64').toString(),'private fixture file');
 assert.equal(JSON.stringify(result).includes('never-export-private-token'),false);
 const forged=structuredClone(result.body.result);forged.content.push({type:'text',text:'hidden instruction'});
 assert.throws(()=>adapter.projectToolResult({name:'get_fixture_attachment',arguments:{message_id:id,attachment_index:0}},forged,true));
 forged.content.pop();forged.content[1].resource.uri='https://untrusted.example.com/secret';
 assert.throws(()=>adapter.projectToolResult({name:'get_fixture_attachment',arguments:{message_id:id,attachment_index:0}},forged,true));
 const bytes=Buffer.alloc(150000,65),args={message_id:id,type:'file',data:bytes.toString('base64'),mime_type:'application/octet-stream',name:'answer.bin',idempotency_key:'media-once'};
 const queued=await rpc(route.port,key,'tools/call',{name:'reply_fixture_media',arguments:args});assert.equal(queued.status,200);await settle(service);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].media.data.length,bytes.length);assert.equal(f.calls[0].message.conversationId,'fixture-chat');
 service.call('reply_fixture_media',args);await settle(service);assert.equal(f.calls.length,1);
 assert.throws(()=>service.call('reply_to_fixture',{message_id:id,text:'second reply',idempotency_key:'second'}));
});

test('invalid media never queues and uncertain media never retries across restart',async t=>{
 const f=mediaFixture(t,{send:async()=>{throw Error('synthetic uncertain');},validate:({media})=>{if(media.mimeType==='audio/unsupported')throw Error('unsupported');}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest(incoming());await settle(service);
 const args={message_id:id,type:'file',data:Buffer.from('safe').toString('base64'),mime_type:'application/octet-stream',name:'a.bin',idempotency_key:'once'};
 for(const change of [{recipient:'someone'}, {name:'../a'}, {data:'%%%='}, {type:'image',mime_type:'image/png'}, {text:'x'.repeat(21)}, {data:Buffer.alloc(MAX_MEDIA_BYTES+1).toString('base64')},{type:'audio',mime_type:'audio/unsupported'}])assert.throws(()=>service.call('reply_fixture_media',{...args,...change}));
 assert.equal(service.store.message(id).reply_state,'none');service.call('reply_fixture_media',args);await settle(service);assert.equal(service.store.message(id).reply_state,'uncertain');
 await service.close();const calls=[];
 const next=new ChannelService(f.config,{transport:transportFixture().send,createProvider:()=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async()=>{},readAttachment:async()=>{},sendMediaReply:async()=>calls.push(1)})});beforeFixtureCleanup(t,()=>next.close());
 await settle(next);next.call('reply_fixture_media',args);await settle(next);assert.deepEqual(calls,[]);assert.equal(next.store.message(id).reply_state,'uncertain');
});

test('attachment authorization is rechecked after download and transcript, and concurrent reads are bounded',async t=>{
 let finish;const bytes=Buffer.from('private bytes'),f=mediaFixture(t,{read:()=>new Promise(resolve=>{finish=()=>resolve({data:bytes,mimeType:'application/octet-stream',name:'a.bin'});})}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'file'}]});await settle(service);
 const reading=service.call('get_fixture_attachment',{message_id:id,attachment_index:0});assert.throws(()=>service.call('get_fixture_attachment',{message_id:id,attachment_index:0}));
 const {secret,...delivery}=subscription().delivery;service.unsubscribe({name:subscription().name,arguments:{conversation:'owner'},delivery});finish();await assert.rejects(reading);
 assert.equal(bytes.every(n=>n===0),true);
});

test('media upload cannot proceed to final send after subscription revocation',async t=>{
 let finish,uploaded,finalSends=0;const started=new Promise(resolve=>{uploaded=resolve;});
 const f=mediaFixture(t,{send:async({authorize})=>{authorize();uploaded();await new Promise(resolve=>{finish=resolve;});authorize();finalSends++;}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest(incoming());await settle(service);
 service.call('reply_fixture_media',{message_id:id,type:'file',data:Buffer.from('test').toString('base64'),mime_type:'text/plain',name:'a.txt',idempotency_key:'once'});
 await started;const {secret,...delivery}=subscription().delivery;service.unsubscribe({name:subscription().name,arguments:{conversation:'owner'},delivery});finish();await settle(service);
 assert.equal(finalSends,0);assert.equal(service.store.message(id).reply_state,'uncertain');
});

test('stored media limit includes the new encrypted reply before queueing',async t=>{
 const f=mediaFixture(t),{service}=f;await service.subscribe(subscription());
 const previous=await service.ingest(incoming('old')),id=await service.ingest(incoming('new'));await settle(service);
 service.store.db.prepare("UPDATE channel_messages SET reply=zeroblob(?),reply_state='sent' WHERE id=?").run(64*1024*1024-100,previous);
 assert.throws(()=>service.call('reply_fixture_media',{message_id:id,type:'file',data:Buffer.alloc(100).toString('base64'),mime_type:'application/octet-stream',name:'a.bin',idempotency_key:'once'}),e=>e.code===-32013);
 assert.equal(service.store.message(id).reply_state,'none');
});

test('voice attachment keeps its original bytes and an explicitly marked reference transcript',async t=>{
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
 const f=mediaFixture(t,{read:async()=>({data:Buffer.from(wav),mimeType:'audio/wav',name:'voice.wav'}),transcribe:async(_bytes,{authorize})=>{authorize();return {extraction_status:'complete',extracted_text:'synthetic reference transcript'};}}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming(),attachments:[{kind:'audio'}]});await settle(service);
 const result=await service.call('get_fixture_attachment',{message_id:id,attachment_index:0});assert.equal(result[RICH_TOOL_RESULT],true);assert.equal(result.value.extracted_text,'synthetic reference transcript');assert.equal(result.content[1].type,'audio');assert.deepEqual(Buffer.from(result.content[1].data,'base64'),wav);
});

test('subscription diagnostics retain fixed failure stages across restart without callback paths, keys or raw errors',async t=>{
 const f=fixture(t),{service}=serviceFixture(t,f);
 await assert.rejects(service.subscribe({...subscription(),delivery:{...subscription().delivery,url:'https://unapproved.example.com/private-callback-path'}}));
 const badTransport=async()=>{throw Error('private callback path, secret and owner must not be reported');};badTransport.preflight=()=>({ready:true});service.transport=badTransport;
 await assert.rejects(service.subscribe(subscription()),e=>e.code===-32015&&e.data.reason==='challenge_failed');
 const diagnostics=service.setup().subscription_diagnostics;assert.equal(diagnostics.length,2);assert.equal(diagnostics[0].stage,'policy');assert.equal(diagnostics[0].reason,'callback_policy_required');assert.equal(diagnostics[1].stage,'challenge');assert.equal(diagnostics[1].code,-32015);
 for(const token of ['private-callback-path','from-current-dot','whsec_','fixture-owner','must not be reported'])assert.equal(JSON.stringify(diagnostics).includes(token),false);
 await service.close();const second=serviceFixture(t,f);assert.deepEqual(second.service.setup().subscription_diagnostics,diagnostics);
 const backend=channelServer(f.config(),second.service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter:createChannelAdapter(channel),port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());
 second.service.transport=badTransport;
 const result=await rpc(route.port,fs.readFileSync(f.keys[1],'utf8'),'events/subscribe',subscription());assert.equal(result.body.error.code,-32015);assert.deepEqual(result.body.error.data,{reason:'challenge_failed',callback_hostname:'callback.example.com'});
 assert.throws(()=>createChannelConfig(channel,{...f.env,CALLBACK_HOSTS:'',MCP_CALLBACK_ALLOWED_HOSTS:'callback.example.com'}),/CALLBACK_HOSTS/);
});

test('setup reports actual subscription expiry and complete durable work counts without changing the database',async t=>{
 const f=fixture(t),{service}=serviceFixture(t,f),initial=service.setup();
 assert.equal(initial.subscription_status.state,'none');assert.equal(initial.subscription_status.expires_at,null);
 assert.equal(initial.connection_status.diagnostic_history,'unavailable');assert.equal(initial.connection_status.callback_hosts_count,1);
 assert.equal(initial.connection_status.callback_hosts_configured,true);assert.equal(initial.connection_status.legacy_callback_alias_present,false);
 await service.subscribe(subscription());await settle(service);
 const record=service.store.get('subscription'),before=service.store.db.prepare("SELECT value FROM channel_metadata WHERE key='subscription'").get().value;
 assert.equal(service.setup().subscription_status.expires_at,new Date(record.expires).toISOString());
 assert.equal(service.setup().connection_status.reason,'ready');
 service.clock=()=>record.expires+1;
 assert.equal(service.setup().subscription_status.state,'expired');assert.equal(service.setup().connection_status.next_step,'renew_in_original_dot');
 assert.equal(service.store.db.prepare("SELECT value FROM channel_metadata WHERE key='subscription'").get().value,before);
 service.clock=Date.now;service.store.set('subscription',{...record,active:false});
 for(let i=0;i<18;i++){const id=await service.ingest(incoming(`count-${i}`));service.store.db.prepare('UPDATE channel_messages SET reply_state=? WHERE id=?').run(i<12?'pending':i<16?'processing':'uncertain',id);}
 const snapshot=service.setup();assert.deepEqual(snapshot.reply_work,{pending:12,processing:4,uncertain:2});assert.equal(snapshot.pending_messages.length,10);
 await service.close();const reopened=serviceFixture(t,f);assert.deepEqual(reopened.service.setup().reply_work,{pending:12,processing:0,uncertain:6});
});

test('pre-upgrade oversized queued media remains pending and encrypted across restart with no send attempt',async t=>{
 const f=mediaFixture(t),{service}=f;await service.subscribe(subscription());const id=await service.ingest(incoming('legacy-large'));await settle(service);
 const legacy={text:'',idempotencyKey:'legacy-once',media:{type:'file',data:Buffer.alloc(MAX_MEDIA_BYTES+1,65).toString('base64'),mimeType:'application/octet-stream',name:'legacy.bin'}};
 const sealed=service.store.seal(legacy,`reply:${id}`);service.store.db.prepare("UPDATE channel_messages SET reply=?,reply_digest='legacy-fixture',reply_state='pending' WHERE id=?").run(sealed,id);
 await service.drain();assert.equal(f.calls.length,0);assert.equal(service.store.message(id).reply_state,'pending');assert.equal(service.store.message(id).reply,sealed);
 await service.close();let attempts=0;
 const next=new ChannelService(f.config,{transport:transportFixture().send,createProvider:()=>({start:async()=>{},stop:async()=>{},status:()=>({connected:true}),sendReply:async()=>{},readAttachment:async()=>{},sendMediaReply:async()=>{attempts++;}})});beforeFixtureCleanup(t,()=>next.close());
 await next.drain();assert.equal(attempts,0);assert.equal(next.store.message(id).reply_state,'pending');assert.equal(next.store.message(id).reply,sealed);assert.equal(next.setup().reply_work.pending,1);
});

test('maximum-sized attachment and reply traverse the actual authenticated router at the new safe limit',async t=>{
 const f=mediaFixture(t,{read:async()=>({data:Buffer.alloc(MAX_MEDIA_BYTES,65),mimeType:'application/octet-stream',name:'max.bin'})}),{service}=f;
 await service.subscribe(subscription());const id=await service.ingest({...incoming('limit'),attachments:[{kind:'file',name:'max.bin'}]});await settle(service);
 const backend=channelServer(f.config,service),address=await backend.listen(0);beforeFixtureCleanup(t,()=>backend.close());
 const adapter=createChannelAdapter(mediaChannel),router=createApp({host:'127.0.0.1',port:8798,owner:OWNER,operation:'live',liveChannels:['fixture'],ingressKeyFile:f.keys[1],channels:{fixture:{adapter,port:address.port,keyFile:f.keys[0]}}},{approvedLive:true});
 const route=await router.listen(0);beforeFixtureCleanup(t,()=>router.close());const key=fs.readFileSync(f.keys[1],'utf8');
 const read=await rpc(route.port,key,'tools/call',{name:'get_fixture_attachment',arguments:{message_id:id,attachment_index:0}});
 assert.equal(read.status,200);assert.equal(read.body.result.structuredContent.size,MAX_MEDIA_BYTES);
 const args={message_id:id,type:'file',data:Buffer.alloc(MAX_MEDIA_BYTES+1,65).toString('base64'),mime_type:'application/octet-stream',name:'answer.bin',idempotency_key:'max-once'};
 const rejected=await rpc(route.port,key,'tools/call',{name:'reply_fixture_media',arguments:args});assert.equal(rejected.status,400);assert.equal(rejected.body.error.code,-32602);assert.equal(f.calls.length,0);assert.equal(service.store.message(id).reply_state,'none');
 args.data=Buffer.alloc(MAX_MEDIA_BYTES,65).toString('base64');assert.equal((await rpc(route.port,key,'tools/call',{name:'reply_fixture_media',arguments:args})).status,200);await settle(service);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].media.data.length,MAX_MEDIA_BYTES);
 const ready=await rpc(route.port,key,'tools/call',{name:'check_fixture_readiness',arguments:{}});assert.equal(ready.status,200);
 assert.equal(ready.body.result.structuredContent.media_limits.read_bytes,MAX_MEDIA_BYTES);assert.equal(ready.body.result.structuredContent.subscription_status.state,'active');
});

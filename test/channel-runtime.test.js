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
 const catalog=await rpc(route.port,key,'tools/list');assert.equal(catalog.status,200);assert.equal(catalog.body.result.tools.length,4);
 assert.equal((await rpc(route.port,key,'events/list')).body.result.events[0].name,'fixture.message.created');
 const setup=await rpc(route.port,key,'tools/call',{name:'check_fixture_readiness',arguments:{}});assert.equal(setup.status,200);assert.equal(setup.body.result.structuredContent.binding_ready,true);
 assert.equal((await rpc(route.port,'invalid','tools/list')).status,401);
 const subscribed=await rpc(route.port,key,'events/subscribe',subscription());assert.match(subscribed.body.result.id,/^sub_/);
 const id=await service.ingest(incoming());await settle(service);const msg=await rpc(route.port,key,'tools/call',{name:'get_fixture_message',arguments:{message_id:id}});assert.equal(msg.body.result.structuredContent.text,'private synthetic message');
});

test('dedicated loopback webhook forwards bounded raw bytes only to signature-verifying provider',async t=>{
 const f=fixture(t),seen=[];const app=webhookServer({...f.config(),webhookPort:8895},{handleWebhook:async input=>{seen.push(input);return {status:input.headers['x-test-signature']==='valid'?200:401,body:''};}});const address=await app.listen(0);beforeFixtureCleanup(t,()=>app.close());
 const request=signature=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:address.port,path:'/webhook',method:'POST',headers:{'content-type':'application/json','x-test-signature':signature}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{"synthetic":true}');});
 assert.equal(await request('valid'),200);assert.equal(await request('invalid'),401);assert.equal(Buffer.isBuffer(seen[0].body),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionDiagnostics,subscriptionStatus,connectionStatus,runtimeStatusProperties,projectRuntimeStatus,optionalStatusSchemaMatch,trackSubscriptionAttempt} from '../channels/status.js';
import {createChannelAdapter} from '../channels/contract.js';
import {DatabaseSync} from 'node:sqlite';
import {inspectLegacyRuntimeStatus,legacySubscriptionDiagnostics} from '../channels/legacy-status.js';

const now=Date.parse('2026-10-31T00:00:00Z');
const diagnostic={at:new Date(now).toISOString(),stage:'challenge',code:-32015,reason:'timeout',hostname:'callback.example.com'};

test('diagnostic projection retains actual safe failure fields without exporting legacy arbitrary data',()=>{
 const input=[{...diagnostic,url:'https://callback.example.com/private-secret',message:'owner-private-message'},
  {...diagnostic,reason:'private-identity'}, {...diagnostic,stage:'private-identity'}, {...diagnostic,code:123456789}, {...diagnostic,hostname:'https://callback.example.com/private-secret'}];
 assert.deepEqual(subscriptionDiagnostics(input),[diagnostic]);
 assert.deepEqual(subscriptionDiagnostics(undefined),[]);
 assert.equal(JSON.stringify(subscriptionDiagnostics(input)).includes('private'),false);
});

test('subscription expiry is read from stored data and missing history is not reconstructed',()=>{
 assert.deepEqual(subscriptionStatus(undefined,now,[]),{state:'none',expires_at:null,remaining_seconds:null,renewal_owner:'host',diagnostics_available:false});
 const record={active:true,expires:now+61000};
 assert.deepEqual(subscriptionStatus(record,now,[diagnostic]),{state:'active',expires_at:new Date(record.expires).toISOString(),remaining_seconds:61,renewal_owner:'host',diagnostics_available:true});
 assert.equal(subscriptionStatus(record,record.expires,[]).state,'expired');
 assert.equal(subscriptionStatus(record,record.expires,[]).remaining_seconds,0);
 assert.equal(subscriptionStatus({...record,active:false},now,[]).state,'disabled');
 assert.equal(subscriptionStatus({active:true},now,[]).state,'unknown');
 assert.equal(subscriptionStatus({active:true},now,[]).expires_at,null);
});

test('connection advice is derived from observed stages and never from configuration presence alone',()=>{
 const input={gatewayConnected:true,callbackHosts:['callback.example.com'],subscription:subscriptionStatus(undefined,now,[]),diagnostics:[],callbackAllowed:false};
 assert.equal(connectionStatus(input).reason,'subscription_missing');
 assert.equal(connectionStatus(input).diagnostic_history,'unavailable');
 assert.equal(connectionStatus({...input,diagnostics:[diagnostic]}).next_step,'inspect_subscription_diagnostics');
 assert.equal(connectionStatus({...input,callbackHosts:[]}).reason,'callback_hosts_empty');
 assert.equal(connectionStatus({...input,gatewayConnected:false}).stage,'gateway');
 const active=subscriptionStatus({active:true,expires:now+1000},now,[]);
 assert.equal(connectionStatus({...input,subscription:active}).reason,'callback_host_not_allowlisted');
 assert.equal(connectionStatus({...input,subscription:active,callbackAllowed:true}).reason,'ready');
 assert.equal(connectionStatus({...input,subscription:subscriptionStatus({active:true},now,[])}).reason,'subscription_unknown');
 const legacy=connectionStatus({...input,settingName:'MCP_CALLBACK_ALLOWED_HOSTS',wrongSettingPresent:true});
 assert.equal(legacy.callback_setting_name,'MCP_CALLBACK_ALLOWED_HOSTS');assert.equal(legacy.wrong_callback_setting_present,true);assert.equal(Object.hasOwn(legacy,'legacy_callback_alias_present'),false);
});

test('new setup schemas can safely consume legacy backends that do not advertise optional status fields',()=>{
 const adapter=createChannelAdapter({id:'fixture',name:'Fixture',envPrefix:'FIXTURE',defaultPort:8799}),expected=adapter.backendSetupTool.outputSchema;
 const optional=['subscription_status','connection_status','reply_work','media_limits','media_readiness','reply_capabilities'];
 const legacy={...expected,properties:Object.fromEntries(Object.entries(expected.properties).filter(([key])=>!optional.includes(key)))};
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 assert.equal(adapter.matchesBackendOutputSchema(adapter.backendSetupTool.name,legacy,expected,same),true);
 assert.equal(adapter.matchesBackendOutputSchema(adapter.backendSetupTool.name,{...legacy,properties:{...legacy.properties,private_identity:{type:'string'}}},expected,same),false);
 const value={binding_ready:true,gateway_connected:true,subscription_active:false,callback_hostname:null,callback_policy:'not_provided',pending_messages:[],subscription_diagnostics:[]};
 assert.deepEqual(adapter.projectToolResult({name:adapter.readinessTool.name,arguments:{}},{isError:false,structuredContent:value},true),value);
 assert.equal(Object.hasOwn(value,'subscription_status'),false);
});

test('canonical status schema/projection reject secret-bearing diagnostics and preserve absent observations',()=>{
 assert.deepEqual(projectRuntimeStatus({unrelated:'private-message'}),{});
 assert.deepEqual(projectRuntimeStatus({subscription_diagnostics:[diagnostic],reply_work:{pending:11,processing:2,uncertain:3}}),{subscription_diagnostics:[diagnostic],reply_work:{pending:11,processing:2,uncertain:3}});
 assert.throws(()=>projectRuntimeStatus({subscription_diagnostics:[{...diagnostic,hostname:'https://callback.example.com/private-secret'}]}));
 assert.throws(()=>projectRuntimeStatus({subscription_diagnostics:[{...diagnostic,raw_error:'private-message'}]}));
 assert.throws(()=>projectRuntimeStatus({subscription_active:true,subscription_status:subscriptionStatus(undefined,now,[])}));
 const properties=runtimeStatusProperties(),expected={type:'object',properties:{connection_status:properties.connection_status},additionalProperties:false};
 const legacy=structuredClone(expected);delete legacy.properties.connection_status.properties.callback_setting_name;delete legacy.properties.connection_status.properties.wrong_callback_setting_present;
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 assert.equal(optionalStatusSchemaMatch(legacy,expected,same),true);
 legacy.properties.connection_status.properties.owner_secret={type:'string'};assert.equal(optionalStatusSchemaMatch(legacy,expected,same),false);
});

test('shared subscription diagnostic tracker preserves real code/stage and cannot change subscription outcome',async()=>{
 let saved=[];const options={clock:()=>now,load:()=>saved,save:v=>{saved=v;}};
 const params={delivery:{url:'https://callback.example.com/private-callback-path'}};
 const error=Object.assign(Error('raw private upstream failure'),{code:-32013});
 await assert.rejects(trackSubscriptionAttempt(params,async d=>{d.stage='persist';d.raw_error='private secret';throw error;},options),e=>e===error);
 assert.deepEqual(saved,[{at:new Date(now).toISOString(),stage:'persist',code:-32013,reason:'subscription_conflict',hostname:'callback.example.com'}]);
 const success={id:'synthetic-subscription'};assert.equal(await trackSubscriptionAttempt(params,async()=>success,{...options,save:()=>{throw Error('private storage failure');}}),success);
 assert.equal(JSON.stringify(saved).includes('private'),false);
});

test('legacy SQLite status reads actual principal-bound expiry and all outbound jobs without exposing private callbacks',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE subscriptions(id TEXT PRIMARY KEY,principal TEXT,callback TEXT,active INTEGER,expires INTEGER,verified_until INTEGER); CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,state TEXT);');
 // Opaque vault fixture tests the delegation boundary; provider tests exercise
 // their existing AES vault. No replacement encryption is used in production.
 const sealed=new Map();let nonce=0;
 const vault={seal:(value,aad)=>{const key=`opaque-fixture-${++nonce}`;sealed.set(key,{aad,value:structuredClone(value)});return key;},open:(key,aad)=>{const entry=sealed.get(key);assert.equal(entry.aad,aad);return structuredClone(entry.value);}};
 const store={vault,get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),run:(sql,...args)=>db.prepare(sql).run(...args),subscription(id){const row=this.get('SELECT * FROM subscriptions WHERE id=?',id);return {...row,...vault.open(row.callback,`subscription:${id}`)};}};
 const add=(id,principal,active,expires,verified)=>store.run('INSERT INTO subscriptions VALUES (?,?,?,?,?,?)',id,principal,vault.seal({url:'https://callback.example.com/private-path',secret:'private-signing-secret'},`subscription:${id}`),active,expires,verified);
 const options={principal:'fixture-owner',now,callbackHosts:['callback.example.com'],bindingReady:true,gatewayConnected:true,callbackAllowed:()=>true,wrongSettingPresent:true};
 const empty=inspectLegacyRuntimeStatus(store,options);assert.equal(empty.subscription_status.state,'none');assert.equal(empty.connection_status.diagnostic_history,'unavailable');
 add('current','fixture-owner',1,now+60000,now-20);add('expired','fixture-owner',1,now-1,now-10);add('other-owner','other-private-owner',1,now+120000,now);
 for(let i=0;i<18;i++)store.run('INSERT INTO jobs VALUES (?,?,?)',`outbound-${i}`,i<12?'reply':i<16?'stream':'feedback',i<12?'pending':i<16?'processing':'uncertain');
 store.run('INSERT INTO jobs VALUES (?,?,?)','event','event','pending');
 const before=store.get('SELECT total_changes() AS n').n,status=inspectLegacyRuntimeStatus(store,options);
 assert.equal(status.subscription_status.expires_at,new Date(now+60000).toISOString());assert.equal(status.subscription_active,true);
 assert.deepEqual(status.reply_work,{pending:12,processing:4,uncertain:2});assert.equal(store.get('SELECT total_changes() AS n').n,before);
 assert.equal(status.connection_status.callback_setting_name,'MCP_CALLBACK_ALLOWED_HOSTS');assert.equal(status.connection_status.wrong_callback_setting_present,true);
 assert.equal(Object.hasOwn(status.connection_status,'legacy_callback_alias_present'),false);
 for(const token of ['private-path','private-signing-secret','fixture-owner','other-private-owner','current'])assert.equal(JSON.stringify(status).includes(token),false);
 assert.equal(inspectLegacyRuntimeStatus(store,{...options,callbackAllowed:()=>false}).subscription_active,false);
 assert.equal(Object.hasOwn(inspectLegacyRuntimeStatus(store,{...options,gatewayConnected:undefined}),'gateway_connected'),false);
 const diagnostics=legacySubscriptionDiagnostics(store);diagnostics.save([{...diagnostic,raw_error:'private-error'}]);assert.deepEqual(diagnostics.load(),[diagnostic]);
 assert.equal(JSON.stringify(store.all('SELECT * FROM metadata')).includes('private-error'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionDiagnostics,subscriptionStatus,connectionStatus} from '../channels/status.js';
import {createChannelAdapter} from '../channels/contract.js';

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

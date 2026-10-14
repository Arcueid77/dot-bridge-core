import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {registerAdapters} from '../router/registry.js';
import {readConfig,validateConfig} from '../router/config.js';
import {createApp} from '../router/server.js';
import {toolCatalog,eventCatalog} from '../router/catalog.js';
import {validateEventCall,validateToolCall} from '../router/live-contract.js';
import {OWNER,VERSION,SERVICE_HEADER,metadata,object} from '../router/common.js';
import {privateMkdtempSync,cleanupPrivateFixture,beforeFixtureCleanup} from '../packages/dot-bridge-platform/test-fixtures.js';
const inputSchema={type:'object',properties:{},additionalProperties:false};
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
function adapter(id='fixture',envPrefix='FIXTURE',defaultPort=8788){
 const ready={name:`check_${id}`,inputSchema,annotations},tool={name:`reply_${id}`,inputSchema,outputSchema:inputSchema,annotations};
 return {id,envPrefix,defaultPort,serviceKeyNewline:false,readinessTool:ready,liveReadinessTool:ready,backendSetupTool:ready,readinessBackendTools:[ready],liveTools:[tool],
  event:{name:`${id}.message.created`,delivery:['webhook'],inputSchema:{type:'object',properties:{conversation:{type:'string',const:'owner'}},required:['conversation'],additionalProperties:false},payloadSchema:inputSchema},scopes:['owner'],
  limits:{request:32768,response:32768,body:32768,bodyTools:{},requestTools:{},responseTools:{},timeouts:{}},
  validateToolArguments(_name,args){object(args,[]);return {};},projectToolResult(_call,result){object(result.structuredContent,[]);return {};},
  matchesBackendOutputSchema(_name,actual,expected,same){return same(actual,expected);},isCallbackPolicyError:()=>false};
}
function fixture(t,descriptors=[adapter()]){
 const directory=privateMkdtempSync(path.join(os.tmpdir(),'core-router-test-'));cleanupPrivateFixture(t,directory);
 const keys=[101,102,103].map(n=>Buffer.alloc(32,n).toString('base64url'));
 const files=keys.map((key,i)=>{const file=path.join(directory,`key-${i}`);fs.writeFileSync(file,key,{mode:0o600});return file;});
 const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OWNER_ID:OWNER,TUNNEL_SERVICE_KEY_FILE:files[0],TUNNEL_SERVICE_OPERATION:'live',TUNNEL_LIVE_CHANNELS:descriptors.map(a=>a.id).join(',')};
 descriptors.forEach((a,i)=>{env[`${a.envPrefix}_SERVICE_KEY_FILE`]=files[i+1];});
 return {directory,keys,files,env,config:readConfig(env,descriptors)};
}
test('one registered channel needs only its own port and key; omitted providers are absent',t=>{
 const f=fixture(t);assert.deepEqual(Object.keys(f.config.channels),['fixture']);assert.equal(toolCatalog(f.config).length,2);assert.equal(eventCatalog(f.config).length,1);
 for(const extra of [{QQ_SERVICE_KEY_FILE:f.files[2]},{LARK_MCP_PORT:'8787'},{FIXTURE_APP_ID:'should-not-be-read'},{TUNNEL_CHANNELS:'missing'},{TUNNEL_LIVE_CHANNELS:'fixture,missing'}])assert.throws(()=>readConfig({...f.env,...extra},[adapter()]));
 assert.throws(()=>validateToolCall(f.config,{name:'reply_to_qq',arguments:{}}));
});
test('configuration is a frozen snapshot and cannot add channels, scopes or larger limits',t=>{
 const supplied=adapter(),f=fixture(t,[supplied]);supplied.scopes.push('configured');supplied.liveTools.push({...supplied.liveTools[0],name:'new_tool'});supplied.limits.request=12582912;
 assert.deepEqual(f.config.channels.fixture.adapter.scopes,['owner']);assert.equal(f.config.channels.fixture.adapter.liveTools.length,1);assert.equal(f.config.channels.fixture.adapter.limits.request,32768);
 assert.ok(Object.isFrozen(f.config.channels.fixture.adapter.event.payloadSchema));
});
test('adapter validation exceptions are normalized across separately installed core copies',t=>{
 const a=adapter();a.validateToolArguments=()=>{throw Object.assign(new Error('synthetic-private-canary'),{status:500,code:-32015});};const f=fixture(t,[a]);
 assert.throws(()=>validateToolCall(f.config,{name:'reply_fixture',arguments:{}}),e=>e.status===400&&e.code===-32602&&!e.message.includes('canary'));
});
test('adapter registration rejects collisions and oversized budgets',()=>{
 assert.throws(()=>registerAdapters([adapter(),adapter()]));const a=adapter('other','OTHER',8787);a.liveTools[0].name='reply_fixture';assert.throws(()=>registerAdapters([adapter(),a]));
 assert.throws(()=>registerAdapters([{...adapter(),limits:{...adapter().limits,response:12582913}}]));
 assert.throws(()=>registerAdapters([{...adapter(),unapprovedModulePath:'/tmp/untrusted.js'}]));
});
test('selected subset never requires an omitted adapter backend or service credential',t=>{
 const f=fixture(t);const descriptors=[adapter(),adapter('other','OTHER',8787)];
 const c=readConfig({...f.env,TUNNEL_CHANNELS:'fixture'},descriptors);assert.deepEqual(Object.keys(c.channels),['fixture']);
 assert.throws(()=>readConfig({...f.env,TUNNEL_CHANNELS:'fixture',OTHER_SERVICE_KEY_FILE:f.files[2]},descriptors));
});
test('configured live subset remains distinct from installed/readiness channels',t=>{
 const f=fixture(t,[adapter(),adapter('other','OTHER',8787)]);const c=readConfig({...f.env,TUNNEL_LIVE_CHANNELS:'fixture'},[adapter(),adapter('other','OTHER',8787)]);
 assert.equal(toolCatalog(c).some(t=>t.name==='reply_other'),false);assert.equal(toolCatalog(c).some(t=>t.name==='check_other'),true);
 assert.throws(()=>validateToolCall(c,{name:'reply_other',arguments:{}}));
});
test('router rejects shared ports, key paths and credential contents',t=>{
 const f=fixture(t);assert.throws(()=>validateConfig({...f.config,channels:{fixture:{...f.config.channels.fixture,port:f.config.port}}}));
 assert.throws(()=>validateConfig({...f.config,channels:{fixture:{...f.config.channels.fixture,keyFile:f.files[0]}}}));
 fs.writeFileSync(f.files[1],f.keys[0],{mode:0o600});assert.throws(()=>createApp(f.config,{approvedLive:true}));
});
test('event scopes and signing/callback validation remain closed',t=>{
 const f=fixture(t),p={name:'fixture.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://callback.example.test/source',secret:'whsec_'+Buffer.alloc(32,104).toString('base64')},ttlMs:60000};
 assert.equal(validateEventCall(f.config,'events/subscribe',p).channel,'fixture');
 for(const change of [{arguments:{conversation:'configured'}},{delivery:{...p.delivery,url:'http://callback.example.test/source'}},{delivery:{...p.delivery,url:'https://127.0.0.1/source'}},{cursor:'replay'},{ttlMs:604800001},{identity:'caller-claim'}])assert.throws(()=>validateEventCall(f.config,'events/subscribe',{...p,...change}));
});
test('a real loopback router discovers and routes one adapter without a second backend',async t=>{
 const f=fixture(t),a=f.config.channels.fixture.adapter,seen=[];let hostile=false;
 const backend=http.createServer(async(req,res)=>{
  assert.equal(req.headers[SERVICE_HEADER],f.keys[1]);assert.equal(req.headers.authorization,undefined);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));seen.push(body.method);
  const result=body.method==='server/discover'?{supportedVersions:[VERSION],capabilities:{tools:{},events:{}}}:body.method==='tools/list'?{tools:[...a.liveTools,a.backendSetupTool]}:body.method==='events/list'?{events:[a.event]}:{isError:false,structuredContent:hostile?{identity:'untrusted'}:{},content:[{type:'text',text:'untrusted-upstream-instructions'}]};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{resultType:'complete',...result}}));
 });
 beforeFixtureCleanup(t,()=>new Promise(resolve=>{backend.close(resolve);backend.closeAllConnections();}));await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const app=createApp({...f.config,channels:{fixture:{...f.config.channels.fixture,port:backend.address().port}}},{approvedLive:true});beforeFixtureCleanup(t,()=>app.close());const address=await app.listen(0);
 const post=(method,params={},auth=true)=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:address.port,path:'/mcp',method:'POST',agent:false,headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-method':method,'mcp-protocol-version':VERSION,...(method==='tools/call'?{'mcp-name':params.name}:{}),...(auth?{[SERVICE_HEADER]:f.keys[0]}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:metadata()}}));
 });
 assert.equal((await post('server/discover')).status,200);assert.equal((await post('tools/list')).body.result.tools.length,2);
 assert.equal((await post('tools/call',{name:'reply_fixture',arguments:{}})).status,200);assert.ok(seen.includes('tools/call'));
 assert.equal((await post('tools/list',{},false)).status,401);hostile=true;
 const rejected=await post('tools/call',{name:'reply_fixture',arguments:{}});assert.equal(rejected.status,502);assert.equal(JSON.stringify(rejected).includes('untrusted'),false);
 const count=seen.length;assert.equal((await post('tools/call',{name:'reply_other',arguments:{}})).status,403);assert.equal(seen.length,count);
});

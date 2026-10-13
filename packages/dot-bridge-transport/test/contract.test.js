import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {makeCallbackTransport,preflightCallbackTransport,projectCallbackTransportStatus,callbackTransportStatusSchema,
  CallbackTransportError,TRANSPORT_ERROR_CODES,signedHeaders} from '../index.js';
import {configuredProxy,bypassMatches} from '../transport.js';
const URL='https://callback.example.test/private-path?synthetic=only';
const HOST='callback.example.test',PROXY={HTTPS_PROXY:'http://proxy.example.test:3128'},BODY=Buffer.from('{"kind":"synthetic"}');
const HEADERS=signedHeaders({id:'sub_test',key:Buffer.alloc(32,99)},'evt_test',BODY,1800000000000);
const opts=(extra={})=>({method:'POST',headers:HEADERS,body:BODY,hosts:[HOST],beforeConnect:()=>{},...extra});
const response=(status=200,body=Buffer.from('{}'),headers={})=>({status,headers,body});
function direct(config={}){
  const calls={dns:0,requests:[],gates:0};
  const lookup=async()=>{calls.dns++;return config.answers??[{address:'93.184.216.34',family:4}];};
  const request=(url,options,receive)=>{
    const req=new EventEmitter();req.destroy=()=>{if(req.closed)return;req.closed=true;queueMicrotask(()=>req.emit('close'));};
    req.end=body=>{req.body=body;queueMicrotask(()=>{if(req.closed)return;if(config.error){req.emit('error',Object.assign(new Error('PRIVATE_UPSTREAM'),{code:config.error}));return;}
      const res=new EventEmitter();res.statusCode=config.status??200;res.headers=config.headers??{};res.rawHeaders=config.rawHeaders??Object.entries(res.headers).flat();res.complete=false;
      res.destroy=()=>{if(res.closed)return;res.closed=true;queueMicrotask(()=>res.emit('close'));};receive(res);if(res.closed)return;res.emit('data',config.body??Buffer.from('{}'));res.complete=true;res.emit('end');res.destroy();req.destroy();});};
    calls.requests.push({url,options,req});return req;
  };
  const send=makeCallbackTransport({lookup,request,proxyEnv:{},...config.transport});
  return {send,calls,run:extra=>send(URL,opts({beforeConnect:()=>calls.gates++,...extra}))};
}
test('shared six-field schema and projector enforce consistent closed status combinations',()=>{
  assert.equal(callbackTransportStatusSchema.required.length,6);assert.equal(callbackTransportStatusSchema.additionalProperties,false);assert.ok(Object.isFrozen(callbackTransportStatusSchema.properties.mode.enum));
  const states=[preflightCallbackTransport({proxyEnv:{}}),preflightCallbackTransport({proxyEnv:PROXY}),preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:{send:async()=>response()}}),
    {ready:false,mode:'blocked',reason:'transport_unverified',proxy_configured:null,destination_binding:'unverified',network_checked:false}];
  for(const state of states){const projected=projectCallbackTransportStatus(state);assert.deepEqual(projected,state);assert.notEqual(projected,state);assert.ok(Object.isFrozen(projected));}
  for(const value of [undefined,null,{},[],{...states[0],network_checked:true},{...states[0],ready:false},{...states[1],ready:true},{...states[2],destination_binding:'direct_pinned'},
    {...states[3],proxy_configured:false},{...states[0],hostname:HOST}])assert.throws(()=>projectCallbackTransportStatus(value));
});
test('factory can construct blocked readiness; missing adapter refuses before DNS and never implies verified policy',async()=>{
  let calls=0;const send=makeCallbackTransport({proxyEnv:PROXY,lookup:async()=>{calls++;return[];},request:()=>{calls++;}});
  assert.deepEqual(send.preflight(),{ready:false,mode:'blocked',reason:'proxy_policy_unverified',proxy_configured:true,destination_binding:'unverified',network_checked:false});
  await assert.rejects(()=>send(URL,opts()),e=>e instanceof CallbackTransportError&&e.code==='proxy_policy_unverified'&&e.reason===e.code);assert.equal(calls,0);
  assert.equal(preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:{verified:true}}).reason,'adapter_invalid');
  assert.equal(preflightCallbackTransport({proxyEnv:{...PROXY,CALLBACK_PROXY_VERIFIED:'true'}}).ready,false);
});
test('production exact-host policy is mandatory and fails before DNS for unapproved destinations',async()=>{
  const f=direct();for(const hosts of [undefined,[],['other.example.test'],['*'],['.example.test'],HOST])await assert.rejects(()=>f.run({hosts}),e=>e.code==='host_not_allowed');assert.equal(f.calls.dns,0);
  await f.run();assert.equal(f.calls.dns,1);assert.equal(f.calls.requests.length,1);assert.equal(f.calls.requests[0].options.headers.host,HOST);
  assert.equal(f.send.preflight().destination_binding,'direct_pinned');
});
test('dynamic callback policy is explicit code-only and does not weaken production defaults',async()=>{
  const f=direct({transport:{callbackPolicy:'authenticated-dynamic-public-https'}});await f.run({hosts:undefined});assert.equal(f.calls.requests.length,1);
  await assert.rejects(()=>f.run({hosts:[HOST]}),e=>e.code==='invalid_input');
  assert.throws(()=>makeCallbackTransport({callbackPolicy:'environment_verified'}),e=>e.code==='invalid_options');
});
test('production body/response ceiling is 256KiB; header cap stays 8KiB and bounds remain separate',async()=>{
  const body=Buffer.alloc(262144,120),f=direct({body});await f.run({body});assert.equal(f.calls.requests[0].req.body.length,262144);
  await assert.rejects(()=>f.run({body:Buffer.alloc(262145)}),e=>e.code==='invalid_input');
  const responseBound=direct({body:Buffer.alloc(8193),transport:{maxBytes:8192}});await assert.rejects(()=>responseBound.run(),e=>e.code==='response_too_large');
  const requestBound=direct({transport:{maxRequestBytes:8192}});await assert.rejects(()=>requestBound.run({body:Buffer.alloc(8193)}),e=>e.code==='invalid_input');
  const headerBound=direct({headers:{'x-long':'x'.repeat(8193)}});await assert.rejects(()=>headerBound.run(),e=>e.code==='invalid_response');
  for(const config of [{maxBytes:262145},{maxRequestBytes:262145},{timeoutMs:30001}])assert.throws(()=>makeCallbackTransport(config),e=>e.code==='invalid_options');
  assert.equal(makeCallbackTransport({timeoutMs:30000,maxBytes:262144,proxyEnv:{}}).preflight().ready,true);
});
test('bounded 408/410/429/5xx statuses reach the app without retry; redirects never follow',async()=>{
  for(const status of [200,204,400,408,410,429,500,503,599]){const f=direct({status});assert.equal((await f.run()).status,status);assert.equal(f.calls.requests.length,1);}
  for(const status of [301,302,307,308]){const f=direct({status,headers:{location:'https://other.example.test'}});await assert.rejects(()=>f.run(),e=>e.code==='redirect_rejected');assert.equal(f.calls.requests.length,1);}
});
test('direct pin validates every answer and preserves original TLS identity with no multi-address retry',async()=>{
  const f=direct({answers:[{address:'93.184.216.34',family:4},{address:'2606:4700:4700::1111',family:6}],error:'ERR_TLS_CERT_ALTNAME_INVALID'});
  await assert.rejects(()=>f.run(),e=>e.code==='tls_failed');assert.equal(f.calls.dns,1);assert.equal(f.calls.requests.length,1);
  const {options}=f.calls.requests[0];assert.equal(options.agent,false);assert.equal(options.autoSelectFamily,false);assert.equal(options.servername,HOST);assert.equal(options.rejectUnauthorized,true);
  const privateAnswer=direct({answers:[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]});await assert.rejects(()=>privateAnswer.run(),e=>e.code==='blocked_address');assert.equal(privateAnswer.calls.requests.length,0);
});
test('a raw callable managed adapter is unverified and receives neither target nor credentials',async()=>{
  let dns=0,adapter=0,requests=0;
  const send=makeCallbackTransport({proxyEnv:PROXY,managedAdapter:{send:async()=>{adapter++;return response();}},
    lookup:async()=>{dns++;throw Object.assign(new Error('synthetic DNS'),{code:'EAI_AGAIN'});},request:()=>requests++});
  assert.deepEqual(send.preflight(),{ready:false,mode:'blocked',reason:'proxy_policy_unverified',proxy_configured:true,destination_binding:'unverified',network_checked:false});
  await assert.rejects(()=>send(URL,opts()),e=>e.code==='proxy_policy_unverified');
  assert.deepEqual({dns,adapter,requests},{dns:0,adapter:0,requests:0});
});
test('synthetic success, malformed responses and raw adapter exceptions cannot certify managed readiness',async()=>{
  for(const reply of [()=>{throw Error('PRIVATE_SECRET '+URL);},()=>response(200),()=>response(302),()=>response(200,Buffer.alloc(8193)),()=>({status:200,body:'not-buffer'})]){
    let calls=0;const send=makeCallbackTransport({proxyEnv:PROXY,lookup:()=>assert.fail('no DNS'),request:()=>assert.fail('no direct fallback'),managedAdapter:{send:async()=>{calls++;return reply();}}});
    await assert.rejects(()=>send(URL,opts()),e=>e instanceof CallbackTransportError&&e.code==='proxy_policy_unverified'&&!JSON.stringify(e).includes('PRIVATE')&&e.cause===undefined);assert.equal(calls,0);
  }
});
test('unverified pending managed adapters never acquire in-flight authority even when the caller aborts',async()=>{
  for(const aborted of [false,true]){
    const controller=new AbortController();if(aborted)controller.abort();let calls=0;
    const send=makeCallbackTransport({proxyEnv:PROXY,managedAdapter:{send:()=>{calls++;return new Promise(()=>{});}},lookup:()=>assert.fail('no DNS')});
    await assert.rejects(()=>send(URL,opts({signal:controller.signal})),e=>e.code==='proxy_policy_unverified');assert.equal(calls,0);
  }
});
test('selected proxy and NO_PROXY parsing remain strict without treating local DNS as proxy proof',async()=>{
  const env={https_proxy:'http://chosen.example.test',HTTPS_PROXY:'unused-invalid',ALL_PROXY:'socks5://unused/path',no_proxy:'93.184.216.0/24',NO_PROXY:'invalid/unused'};
  const proxy=configuredProxy(env);assert.equal(bypassMatches(proxy,HOST,['93.184.216.34']),true);assert.equal(bypassMatches(proxy,HOST,['1.1.1.1']),false);
  assert.equal(preflightCallbackTransport({proxyEnv:env}).reason,'proxy_policy_unverified');assert.equal(preflightCallbackTransport({proxyEnv:{ALL_PROXY:'socks5://only/path'}}).reason,'proxy_unsupported');
  const send=makeCallbackTransport({proxyEnv:env,managedAdapter:{send:()=>assert.fail('no delegation')},lookup:()=>assert.fail('no local lookup to certify proxy')});
  await assert.rejects(()=>send(URL,opts()),e=>e.code==='proxy_policy_unverified');
  assert.equal(preflightCallbackTransport({proxyEnv:null}).reason,'proxy_unsupported');
});
test('proxy or adapter changes cannot turn an unverified sender into an allowed route',async()=>{
  const proxyEnv={...PROXY},managedAdapter={send:async()=>response()},send=makeCallbackTransport({proxyEnv,managedAdapter,lookup:()=>assert.fail('no DNS')});
  managedAdapter.send=async()=>response();assert.equal(send.preflight().reason,'adapter_invalid');await assert.rejects(()=>send(URL,opts()),e=>e.code==='adapter_invalid');
  delete proxyEnv.HTTPS_PROXY;assert.equal(send.preflight().reason,'adapter_invalid');await assert.rejects(()=>send(URL,opts()),e=>e.code==='adapter_invalid');
  const unchangedAdapter={send:async()=>response()},env={...PROXY},other=makeCallbackTransport({proxyEnv:env,managedAdapter:unchangedAdapter});delete env.HTTPS_PROXY;
  assert.equal(other.preflight().reason,'proxy_unsupported');await assert.rejects(()=>other(URL,opts()),e=>e.code==='proxy_unsupported');
});
test('a business authorization gate cannot replace the missing managed destination-binding capability',async()=>{
  let gates=0,operations=0;
  const send=makeCallbackTransport({proxyEnv:PROXY,lookup:()=>assert.fail('no DNS'),managedAdapter:{send:async(_target,request)=>request.beforeConnect(()=>{operations++;return response();})}});
  await assert.rejects(()=>send(URL,opts({beforeConnect:()=>{gates++;}})),e=>e.code==='proxy_policy_unverified');
  assert.equal(gates,0);assert.equal(operations,0);
});
test('status preflight never substitutes explicit null or trusts inherited adapter methods',()=>{
  assert.deepEqual(makeCallbackTransport({proxyEnv:null}).preflight(),{ready:false,mode:'blocked',reason:'proxy_unsupported',proxy_configured:false,destination_binding:'unverified',network_checked:false});
  const inherited=Object.assign(Object.create({send:async()=>response()}),{unrelated:true});assert.equal(preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:inherited}).reason,'adapter_invalid');
  const hostile={};Object.defineProperty(hostile,'https_proxy',{get(){throw Error('PRIVATE_CONFIGURATION');}});
  assert.doesNotThrow(()=>makeCallbackTransport({proxyEnv:hostile}).preflight());assert.equal(makeCallbackTransport({proxyEnv:hostile}).preflight().reason,'proxy_unsupported');
});
test('shared package copies independently without dependencies, workspace paths or network setup',t=>{
  const root=fileURLToPath(new globalThis.URL('../',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'callback-package-copy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['package.json','index.js','status.js','transport.js','README.md'])fs.copyFileSync(path.join(root,name),path.join(dir,name));
  const script=`import {makeCallbackTransport,callbackTransportStatusSchema} from ${JSON.stringify(pathToFileURL(path.join(dir,'index.js')).href)}; const send=makeCallbackTransport({proxyEnv:{}}); if(!send.preflight().ready||callbackTransportStatusSchema.required.length!==6)throw Error('copy contract');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{},encoding:'utf8',timeout:3000});assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('legacy managed/delegated-unverified ready projections are rejected',()=>{
  assert.throws(()=>projectCallbackTransportStatus({ready:true,mode:'managed',reason:'none',proxy_configured:true,destination_binding:'delegated_unverified',network_checked:false}));
  for(const adapter of [{sendPublicHttps:async()=>response()},{send:async()=>response(),verified:true}]){
    assert.equal(preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:adapter}).reason,'adapter_invalid');
  }
});
test('direct EAI_AGAIN remains a DNS failure rather than a managed capability classification',async()=>{
  let dns=0;const f=direct({transport:{lookup:async()=>{dns++;throw Object.assign(new Error('synthetic'),{code:'EAI_AGAIN'});}}});
  await assert.rejects(()=>f.run(),e=>e.code==='dns_failed');assert.equal(dns,1);assert.equal(f.calls.requests.length,0);
});

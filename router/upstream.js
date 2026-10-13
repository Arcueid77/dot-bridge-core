import http from 'node:http';
import { TextDecoder } from 'node:util';
import { VERSION, SERVICE_HEADER, metadata, loopback, object } from './common.js';
import { validateConfig } from './config.js';
import { canonicalKey } from './auth.js';
import { expectedBackendTools, sameSchema, matchesBackendOutputSchema } from './catalog.js';
import { record, unavailable, enabled, validateToolCall, validateEventCall, projectToolResult, projectSubscription, projectUpstreamError } from './live-contract.js';
const MAX_RESPONSE = 524288, MAX_REQUEST = 262144;
const empty = value => record(value) && Object.keys(value).length === 0;
export function createUpstreamClient(input, keys, { approvedLive = false } = {}) {
  const config=validateConfig(input);
  if(config.operation === 'live' && approvedLive !== true)throw new Error('Explicit live activation approval is required');
  const ids=Object.keys(config.channels);
  if(!keys||Object.keys(keys).length!==ids.length||ids.some(id=>!canonicalKey(keys[id]))||new Set(ids.map(id=>keys[id])).size!==ids.length)throw new Error('Independent configured upstream service keys required');
  // Fixed local endpoints only. No proxy env/global agent, redirects or caller
  // headers. Callback URLs are opaque validated parameters to one fixed backend.
  const routes=Object.freeze(Object.fromEntries(ids.map(id=>[id,Object.freeze({port:config.channels[id].port,key:keys[id],adapter:config.channels[id].adapter})])));
  const active=new Set();let stopping=false;
  function call(routeName,method,params={}) {
    const route=routes[routeName];
    if (stopping || !route || !['server/discover','tools/list','events/list','tools/call','events/subscribe','events/unsubscribe'].includes(method)) return Promise.reject(unavailable());
    if (method === 'tools/call') {
      const alias=route.adapter.backendSetupTool.name!==route.adapter.readinessTool.name&&params.name===route.adapter.backendSetupTool.name;
      const input=alias?{...params,name:route.adapter.readinessTool.name}:params;
      const checked=validateToolCall(config,input);
      if(checked.channel!==routeName||(alias&&!enabled(config,routeName))||(!alias&&route.adapter.backendSetupTool.name!==route.adapter.readinessTool.name&&params.name===route.adapter.readinessTool.name))return Promise.reject(unavailable());
    }
    if (method.startsWith('events/') && method !== 'events/list') { const checked=validateEventCall(config,method,params);if(checked.channel !== routeName) return Promise.reject(unavailable()); }
    const body=JSON.stringify({jsonrpc:'2.0',id:'readiness',method,params:{...params,_meta:metadata()}});
    const requestLimit=route.adapter.limits.requestTools[params.name]??route.adapter.limits.request;
    const responseLimit=route.adapter.limits.responseTools[params.name]??route.adapter.limits.response;
    if(Buffer.byteLength(body)>requestLimit)return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      let done=false,timer,req;
      const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);active.delete(req);if(error){req?.destroy();reject(error instanceof Error ? error : unavailable());}else resolve(result);};
      try {
        req=http.request({hostname:'127.0.0.1',port:route.port,path:'/mcp',method:'POST',agent:false,maxHeaderSize:8192,
          headers:{host:`127.0.0.1:${route.port}`,'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(body),connection:'close',
            'mcp-protocol-version':VERSION,'mcp-method':method,...(method === 'tools/call' ? {'mcp-name':params.name} : {}),[SERVICE_HEADER]:route.key}},res=>{
          if (![200,400,401,403,404,409,429,500,502,503].includes(res.statusCode) || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '') ||
              (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'])>responseLimit) {finish(true);res.destroy();return;}
          let size=0;const chunks=[];
          res.on('data',chunk=>{size+=chunk.length;if(size>responseLimit){finish(true);res.destroy();}else chunks.push(chunk);});
          res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
          res.on('end',()=>{if(done)return;try{
            const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
            if(!record(value)||value.jsonrpc!=='2.0'||value.id!=='readiness')throw new Error();
            if(Object.hasOwn(value,'error')) { finish(config.operation === 'live' ? projectUpstreamError(value,params,{method,adapter:route.adapter}) : true);return; }
            if(res.statusCode!==200||!record(value.result)||value.result.resultType!=='complete')throw new Error();
            finish(false,value.result);
          }catch{finish(true);}});
        });active.add(req);
        req.on('socket',socket=>socket.once('connect',()=>{if(!loopback(socket.remoteAddress))finish(true);}));req.on('error',()=>finish(true));
        // No automatic retries: a timed-out mutation may already have committed.
        const timeoutMs=method==='events/subscribe'?35000:method==='tools/call'?(route.adapter.limits.timeouts[params.name]??3000):3000;
        timer=setTimeout(()=>finish(true),timeoutMs);req.end(body);
      }catch{finish(true);}
    });
  }
  async function checkCatalog(channel) {
    const live=enabled(config,channel),discover=await call(channel,'server/discover');
    if(!Array.isArray(discover.supportedVersions)||discover.supportedVersions.length!==1||discover.supportedVersions[0]!==VERSION||!record(discover.capabilities)||
       !empty(discover.capabilities.tools)||!empty(discover.capabilities.events)||Object.keys(discover.capabilities).some(k=>!['tools','events'].includes(k)))throw unavailable();
    const catalog=await call(channel,'tools/list'),expected=expectedBackendTools(config,channel,live);
    if(!Array.isArray(catalog.tools)||catalog.tools.length!==expected.length||new Set(catalog.tools.map(t=>t?.name)).size!==expected.length)throw unavailable();
    for(const tool of catalog.tools){const target=expected.find(x=>x.name===tool?.name);if(!target)throw unavailable();
      if(live && (!sameSchema(tool.inputSchema,target.inputSchema)||!matchesBackendOutputSchema(config,channel,tool.name,tool.outputSchema,target.outputSchema)||!sameSchema(tool.annotations,target.annotations)))throw unavailable();}
    const events=await call(channel,'events/list');
    if(!Array.isArray(events.events)||events.events.length!==(live?1:0)||[catalog,events].some(v=>Object.hasOwn(v,'nextCursor')&&v.nextCursor!==null))throw unavailable();
    if(live){const e=events.events[0],target=config.channels[channel].adapter.event;if(!record(e)||e.name!==target.name||!sameSchema(e.delivery,target.delivery)||!sameSchema(e.inputSchema,target.inputSchema)||!sameSchema(e.payloadSchema,target.payloadSchema))throw unavailable();}
  }
  async function tool(params) {
    const checked=validateToolCall(config,params);await checkCatalog(checked.channel);
    const adapter=config.channels[checked.channel].adapter,live=enabled(config,checked.channel);
    if(checked.name===adapter.readinessTool.name&&adapter.readinessBackendTools.length===0&&!live)return adapter.projectToolResult(checked,null,false);
    const name=checked.name===adapter.readinessTool.name?adapter.backendSetupTool.name:checked.name;
    const result=await call(checked.channel,'tools/call',{name,arguments:checked.arguments});
    return projectToolResult(config,checked,result,live);
  }
  return {
    verifyCatalogs:async()=>{for(const channel of ids)await checkCatalog(channel);},
    tool,
    async event(method,params){
      const checked=validateEventCall(config,method,params);await checkCatalog(checked.channel);
      const startedAt=Date.now(),result=await call(checked.channel,method,checked.params);
      if(method==='events/subscribe')return projectSubscription(result,checked.params,startedAt);
      try{object(result,['resultType','_meta']);return {};}catch{throw unavailable();}
    },
    close(){stopping=true;for(const req of active)req.destroy();active.clear();}
  };
}

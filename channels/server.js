import http from 'node:http';
import {BridgeError,VERSION,rpcResult} from '../router/common.js';
import {checkHeaders} from '../router/server.js';
import {validateMcp} from '../router/protocol.js';
import {createAuthenticator,readServiceKey} from '../router/auth.js';

const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',connection:'close','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req,max){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')||(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'))throw new BridgeError('Expected uncompressed JSON',{status:415});
 if(Number(req.headers['content-length'])>max)throw new BridgeError('Request too large',{status:413});
 let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>max)throw new BridgeError('Request too large',{status:413});chunks.push(chunk);}return Buffer.concat(chunks);
}
function listener(handler){
 const sockets=new Set(),server=http.createServer({maxHeaderSize:8192},handler);server.headersTimeout=5000;server.requestTimeout=10000;server.timeout=15000;server.keepAliveTimeout=1000;server.maxConnections=32;server.maxRequestsPerSocket=1;
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});server.on('clientError',(_e,s)=>s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
 return {server,listen:port=>new Promise((resolve,reject)=>{const fail=e=>{server.off('listening',ready);reject(e);},ready=()=>{server.off('error',fail);resolve(server.address());};server.once('error',fail);server.once('listening',ready);server.listen(port,'127.0.0.1');}),close:()=>new Promise(resolve=>{server.close(()=>resolve());for(const s of sockets)s.destroy();})};
}
export function channelServer(config,service){
 const authenticate=createAuthenticator(readServiceKey(config.tunnelServiceKeyFile,true));let inflight=0,count=0,window=Date.now();
 const app=listener(async(req,res)=>{
  let id=null,acquired=false;
  try{
   checkHeaders(req,app.server.address()?.port);
   if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{status:'ok',channel:config.channel.id,mode:config.operation});
   if(req.url!=='/mcp'||req.method!=='POST')return json(res,404,{error:'Not found'});
   authenticate(req);if(Date.now()-window>=60000){window=Date.now();count=0;}if(inflight>=8||++count>120)throw new BridgeError('Request limit reached',{status:429,code:-32013});inflight++;acquired=true;
   const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,131072))),params=validateMcp(request,req.headers);
   if(!Object.hasOwn(request,'id')){if(request.method!=='notifications/cancelled')throw new BridgeError('Unsupported notification');res.writeHead(202,{connection:'close'});res.end();return;}
   if(typeof request.id==='string'&&request.id.length>256)throw new BridgeError('Invalid request ID');id=request.id;
   let result;
   if(service)result=await service.rpc(request.method,params);
   else{
    if(Object.keys(params).some(k=>!['_meta','cursor'].includes(k))||(params.cursor!==undefined&&params.cursor!==null))throw new BridgeError('Unsupported readiness parameters');
    if(request.method==='server/discover')result={supportedVersions:[VERSION],capabilities:{tools:{},events:{}},ttlMs:0,cacheScope:'private',instructions:'Provider-disabled readiness. No message consumption or subscriptions.'};
    else if(request.method==='tools/list')result={tools:[],ttlMs:0,cacheScope:'private'};
    else if(request.method==='events/list')result={events:[],ttlMs:0,cacheScope:'private'};
    else if(request.method==='ping')result={};else throw new BridgeError('Readiness is read-only',{status:403,code:-32012});
   }
   json(res,200,rpcResult(id,result));
  }catch(error){const safe=error instanceof BridgeError?error:new BridgeError('Channel request unavailable',{status:500,code:-32603});if(!res.headersSent&&!res.destroyed)json(res,safe.status,{jsonrpc:'2.0',id,error:{code:safe.code,message:safe.message,...(safe.data?{data:safe.data}:{})}});}
  finally{if(acquired)inflight--;}
 });return app;
}
export function webhookServer(config,provider){
 let inflight=0;
 const app=listener(async(req,res)=>{
  let acquired=false;
  try{
   // Reverse proxies must rewrite Host to the loopback upstream and strip Origin.
   checkHeaders(req,app.server.address()?.port);
   if(req.method!=='POST'||req.url!=='/webhook')return json(res,404,{error:'Not found'});
   if(inflight>=4)throw Error();inflight++;acquired=true;
   const names=req.rawHeaders.filter((_v,i)=>i%2===0).map(v=>v.toLowerCase());if(new Set(names).size!==names.length)throw Error();
   const bytes=await body(req,262144),result=await provider.handleWebhook({headers:req.headers,body:bytes});
   const status=[200,400,401,403,413,429,500,503].includes(result?.status)?result.status:500;
   res.writeHead(status,{'content-type':'text/plain',connection:'close','cache-control':'no-store'});res.end(typeof result?.body==='string'&&result.body.length<=1024?result.body:'');
  }catch{if(!res.headersSent&&!res.destroyed)json(res,400,{error:'Webhook rejected'});}finally{if(acquired)inflight--;}
 });return app;
}

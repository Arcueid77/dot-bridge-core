import { readConfig } from './config.js';
import { createApp } from './server.js';
import { supervisedStop } from '../packages/dot-bridge-platform/supervised-stop.js';
export async function drainAggregate(app){
  if(!app)return;
  await new Promise((resolve,reject)=>app.server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));
  await app.close();
}
// Adapters are trusted code registered by the owning executable. No module path
// or executable may be supplied by a remote caller or environment setting.
export async function startRouter(adapters,{drain=true}={}){
  let app,closing,finishStart,stopSupervision=()=>{};
  const settled=new Promise(resolve=>{finishStart=resolve;});
  const stop=()=>{stopSupervision();if(!closing)closing=(async()=>{await settled;try{if(drain)await drainAggregate(app);else await app?.close();}catch{process.exitCode=1;}})();return closing;};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop();});
  try{
    const args=process.argv.slice(2);
    if(args.length>1||args.some(arg=>arg!=='--confirm-live'))throw Error();
    const config=readConfig(process.env,adapters);
    if((config.operation==='live')!==(args.length===1))throw Error();
    stopSupervision=supervisedStop(stop);
    app=createApp(config,{approvedLive:config.operation==='live'});await app.listen();
    process.stdout.write(config.operation==='live'?'Private registered-channel live router started; delivery remains unverified.\n':'Private registered-channel readiness router started; provider forwarding disabled.\n');
  }catch{process.exitCode=1;process.stderr.write('Private router refused or failed; no private values printed.\n');finishStart();await stop();}
  finally{finishStart();}
}

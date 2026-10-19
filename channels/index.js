import {createChannelConfig} from './config.js';
import {ChannelService} from './service.js';
import {channelLock} from './lock.js';
import {channelServer,webhookServer} from './server.js';
import {supervisedStop} from '../packages/dot-bridge-platform/supervised-stop.js';
export {createChannelConfig} from './config.js';
export {createChannelAdapter} from './contract.js';
export {ChannelService} from './service.js';
export async function runChannel({channel,createProvider},{mode}={}){
 let service,app,webhook,release,supervision=()=>{};let closing;
 const stop=()=>closing??=(async()=>{supervision();await webhook?.close();await app?.close();await service?.close();await release?.();})();
 try{
  if(mode==='live'&&(process.argv.length!==3||process.argv[2]!=='--confirm-live'))throw Error('Explicit live flag required');
  if(mode==='readiness'&&process.argv.length!==2)throw Error('Unexpected readiness arguments');
  if((process.env.TUNNEL_SERVICE_OPERATION??'readiness')!==mode)throw Error('Entrypoint mode differs');
  const config=createChannelConfig(channel);if(config.operation!==mode)throw Error('Channel mode mismatch');
  if(mode==='live'){
   release=await channelLock(config,{onLost:()=>{process.exitCode=1;void stop().catch(()=>{});}});service=new ChannelService(config,{createProvider});
  }
  app=channelServer(config,service);await app.listen(config.port);
  if(config.webhookPort){if(typeof service.provider.handleWebhook!=='function')throw Error('Webhook provider required');webhook=webhookServer(config,service.provider);await webhook.listen(config.webhookPort);}
  supervision=supervisedStop(()=>stop().catch(()=>{process.exitCode=1;}));
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  await service?.start();process.stdout.write(JSON.stringify({event:'channel_started',channel:channel.id,mode})+'\n');
 }catch{
  process.stderr.write('Channel startup refused or failed; no private values printed.\n');await stop().catch(()=>{});process.exitCode=1;
 }
}

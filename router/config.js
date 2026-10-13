import path from 'node:path';
import { OWNER, object } from './common.js';
import { registerAdapters } from './registry.js';
const fail=()=>{throw new Error('Bridge router configuration is invalid or mixed with provider settings');};
function keyPath(value){if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||value.includes('\0')||value===path.parse(value).root)fail();return value;}
function port(value,fallback){const text=value??String(fallback);if(!/^[1-9][0-9]{0,4}$/.test(text)||Number(text)>65535)fail();return Number(text);}
export function readConfig(env=process.env,adapters){
  const registered=registerAdapters(adapters),ids=registered.map(a=>a.id);
  const selected=env.TUNNEL_CHANNELS===undefined?ids:env.TUNNEL_CHANNELS.split(',');
  if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!ids.includes(id)))fail();
  const operation=env.TUNNEL_SERVICE_OPERATION??'readiness',liveChannels=env.TUNNEL_LIVE_CHANNELS?env.TUNNEL_LIVE_CHANNELS.split(','):[];
  if(env.AUTH_MODE!=='tunnel-service'||env.BRIDGE_MODE!=='tunnel'||(env.TUNNEL_SERVICE_OWNER_ID&&env.TUNNEL_SERVICE_OWNER_ID!==OWNER)||
     (env.TUNNEL_SERVICE_READINESS_ONLY&&(env.TUNNEL_SERVICE_READINESS_ONLY!=='true'||operation!=='readiness')))fail();
  const accepted=new Set(['TUNNEL_CHANNELS','TUNNEL_LIVE_CHANNELS','TUNNEL_SERVICE_KEY_FILE','TUNNEL_SERVICE_OWNER_ID','TUNNEL_SERVICE_READINESS_ONLY','TUNNEL_SERVICE_OPERATION']);
  for(const adapter of registered.filter(a=>selected.includes(a.id)))for(const suffix of ['MCP_PORT','SERVICE_KEY_FILE'])accepted.add(`${adapter.envPrefix}_${suffix}`);
  const prefixes=new Set(['QQ_','LARK_',...registered.map(a=>a.envPrefix+'_')]);
  for(const [name,value] of Object.entries(env))if(value&&!accepted.has(name)&&(
    [...prefixes].some(prefix=>name.startsWith(prefix))||/^(OAUTH_|MCP_|TUNNEL_SERVICE_)/.test(name)||
    ['PUBLIC_ORIGIN','DEV_BEARER_TOKEN','DATABASE_PATH','STORAGE_KEY','ALLOWED_ORIGINS'].includes(name)))fail();
  const channels=Object.fromEntries(selected.map(id=>{const adapter=registered.find(a=>a.id===id);return [id,{adapter,
    port:port(env[`${adapter.envPrefix}_MCP_PORT`],adapter.defaultPort),keyFile:keyPath(env[`${adapter.envPrefix}_SERVICE_KEY_FILE`])}];}));
  return validateConfig({operation,liveChannels,host:env.HOST??'127.0.0.1',port:port(env.PORT,8789),owner:OWNER,ingressKeyFile:keyPath(env.TUNNEL_SERVICE_KEY_FILE),channels});
}
export function validateConfig(value){
  try{object(value,['host','port','owner','ingressKeyFile','operation','liveChannels','channels'],['host','port','owner','ingressKeyFile','channels']);}catch{fail();}
  const operation=value.operation??'readiness',liveChannels=value.liveChannels??[];
  if(!value.channels||typeof value.channels!=='object'||Array.isArray(value.channels))fail();
  const entries=Object.entries(value.channels);
  if(!entries.length||entries.length>16)fail();
  const adapters=registerAdapters(entries.map(([,route])=>route?.adapter));
  const ports=[value.port],files=[keyPath(value.ingressKeyFile)],channels={};
  for(let i=0;i<entries.length;i++){
    const [id,route]=entries[i];try{object(route,['port','keyFile','adapter'],['port','keyFile','adapter']);}catch{fail();}
    if(id!==adapters[i].id)fail();ports.push(route.port);files.push(keyPath(route.keyFile));
    channels[id]=Object.freeze({port:route.port,keyFile:route.keyFile,adapter:adapters[i]});
  }
  if(!['127.0.0.1','::1'].includes(value.host)||value.owner!==OWNER||ports.some(p=>!Number.isInteger(p)||p<1||p>65535)||
     new Set(ports).size!==ports.length||new Set(files).size!==files.length||!['readiness','live'].includes(operation)||
     !Array.isArray(liveChannels)||new Set(liveChannels).size!==liveChannels.length||liveChannels.some(id=>!Object.hasOwn(channels,id))||
     (operation==='readiness'?liveChannels.length!==0:liveChannels.length===0))fail();
  return Object.freeze({...value,operation,liveChannels:Object.freeze([...liveChannels].sort()),channels:Object.freeze(channels)});
}

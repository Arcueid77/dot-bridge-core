import path from 'node:path';
import {readPrivateFile,openPrivateDirectory} from '../packages/dot-bridge-platform/private-files.js';
import {readServiceKey} from '../router/auth.js';
import {validHostname,boundedString} from '../router/live-contract.js';
import {OWNER} from '../router/common.js';

const absolute=value=>{if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||/[\x00-\x1f\x7f]/.test(value))throw Error('Protected absolute path required');return value;};
function privateText(file,maxBytes){let bytes;try{bytes=readPrivateFile(absolute(file),{maxBytes});return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{bytes?.fill(0);}}
export function createChannelConfig(channel,env=process.env){
 const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15)throw Error('Node.js >=24.15 <25 required');
 const operation=env.TUNNEL_SERVICE_OPERATION??'readiness';
 if(env.AUTH_MODE!=='tunnel-service'||env.BRIDGE_MODE!=='tunnel'||!['readiness','live'].includes(operation)||env.TUNNEL_SERVICE_OWNER_ID!==OWNER||(env.HOST??'127.0.0.1')!=='127.0.0.1')throw Error('Explicit owner tunnel mode required');
 const raw=env.PORT??String(channel.defaultPort);if(!/^[1-9][0-9]{0,4}$/.test(raw)||Number(raw)>65535)throw Error('Invalid loopback port');
 const keyFile=absolute(env.TUNNEL_SERVICE_KEY_FILE);readServiceKey(keyFile,true);
 const config={channel,operation,host:'127.0.0.1',port:Number(raw),tunnelServiceKeyFile:keyFile};
 const credentialFile=env[`${channel.envPrefix}_CREDENTIALS_FILE`];
 if(operation==='readiness'){
  if(credentialFile||env.STORAGE_KEY||env.STORAGE_KEY_FILE||env.DATABASE_PATH||(env[`${channel.envPrefix}_TRANSPORT`]??'disabled')!=='disabled')throw Error('Readiness must not load provider configuration');
  return Object.freeze(config);
 }
 if(env.CALLBACK_TRANSPORT_MODE!=='standard'||env.STORAGE_KEY||env[`${channel.envPrefix}_TRANSPORT`]==='disabled')throw Error('Live standard callback configuration required');
 const credentials=JSON.parse(privateText(credentialFile,65536));
 if(!credentials||typeof credentials!=='object'||Array.isArray(credentials))throw Error('Invalid provider credential document');
 boundedString(credentials.ownerId,256);boundedString(credentials.conversationId,256);
 const storageKey=privateText(env.STORAGE_KEY_FILE,46).replace(/\r?\n$/,'');
 if(!/^[A-Za-z0-9+/]{43}=$/.test(storageKey)||Buffer.from(storageKey,'base64').toString('base64')!==storageKey)throw Error('Invalid storage key');
 const dbPath=absolute(env.DATABASE_PATH),bridgeLockDirectory=absolute(env.BRIDGE_LOCK_DIRECTORY);
 for(const directory of [path.dirname(dbPath),bridgeLockDirectory])openPrivateDirectory(directory).close();
 if(new Set([keyFile,credentialFile,env.STORAGE_KEY_FILE,dbPath]).size!==4)throw Error('Protected files must be distinct');
 const callbackHosts=(env.CALLBACK_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(callbackHosts.length>16||new Set(callbackHosts).size!==callbackHosts.length||callbackHosts.some(h=>!validHostname(h)))throw Error('Callback hosts must be exact DNS names');
 const maxReplyText=channel.maxReplyText??20000;
 if(!Number.isSafeInteger(maxReplyText)||maxReplyText<1||maxReplyText>20000)throw Error('Invalid channel text bound');
 Object.assign(config,{credentials,storageKey,dbPath,bridgeLockDirectory,callbackHosts,maxReplyText,subscriptionTtlMs:604800000,retentionMs:604800000});
 if(channel.webhookPort!==undefined){
  const rawWebhook=env[`${channel.envPrefix}_WEBHOOK_PORT`]??String(channel.webhookPort);
  if(!/^[1-9][0-9]{0,4}$/.test(rawWebhook)||Number(rawWebhook)>65535||Number(rawWebhook)===config.port)throw Error('Invalid webhook loopback port');
  config.webhookPort=Number(rawWebhook);
 }
 return Object.freeze(config);
}

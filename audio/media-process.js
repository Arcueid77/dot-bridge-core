import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BridgeError} from '../router/common.js';
import {MAX_MEDIA_BYTES as MAX_ATTACHMENT_BYTES} from '../channels/media.js';
import {assertTrustedRuntimeFile} from './transcription.js';

function executable(name){
  if(process.platform!=='linux')throw new BridgeError('This media conversion requires the protected Linux runtime');
  const resolved=fs.realpathSync('/usr/bin/'+name);
  if(!resolved.startsWith('/usr/bin/'))throw new BridgeError('Untrusted media runtime');
  return assertTrustedRuntimeFile(resolved);
}
export function protectedMediaProcess(name,args,input,{limit=MAX_ATTACHMENT_BYTES,timeout=20000}={}){
  const target=executable(name),launcher=executable('prlimit'),guard=assertTrustedRuntimeFile(process.env.DOT_BRIDGE_AUDIO_GUARD);
  if(!Buffer.isBuffer(input)||!input.length||input.length>MAX_ATTACHMENT_BYTES)throw new BridgeError('Media conversion input refused');
  return new Promise((resolve,reject)=>{
    let child,finished=false,failed=false,size=0;const chunks=[];
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);const result=error?null:Buffer.concat(chunks);chunks.forEach(chunk=>chunk.fill(0));if(error)reject(new BridgeError('Media conversion unavailable or rejected'));else resolve(result);};
    const stop=()=>{failed=true;child?.kill('SIGKILL');};
    const timer=setTimeout(stop,timeout);
    try{
      child=spawn(launcher,['--core=0','--as=536870912','--cpu=15','--',target,...args],{shell:false,windowsHide:true,cwd:'/',stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LD_PRELOAD:guard}});
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limit){chunk.fill(0);stop();}else chunks.push(chunk);});
      child.stderr.on('data',chunk=>chunk.fill(0));child.stdin.on('error',()=>{});child.on('error',()=>{failed=true;});child.on('close',code=>finish(failed||code!==0));
      child.stdin.end(input);
    }catch{stop();finish(true);}
  });
}
export async function opusAudio(bytes){
  if(bytes.subarray(0,4).toString()==='OggS'&&bytes.subarray(0,256).includes(Buffer.from('OpusHead')))return Buffer.from(bytes);
  if(!(bytes.subarray(0,3).toString()==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224)||(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')||bytes.subarray(0,4).toString()==='OggS'))throw new BridgeError('Unsupported audio representation');
  return protectedMediaProcess('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-i','pipe:0','-t','600','-vn','-map_metadata','-1','-threads','1','-c:a','libopus','-f','ogg','pipe:1'],bytes);
}

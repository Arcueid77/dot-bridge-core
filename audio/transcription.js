import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setPriority} from 'node:os';

const INPUT_LIMIT=8*1024*1024, PCM_LIMIT=16000*2*120, TEXT_LIMIT=12000;
const unavailable=()=>({extraction_status:'unsupported'});

function trustedFile(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)throw Error();
  let current=path.resolve(file);
  for(;;){
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))throw Error();
    if(current===file&&(!stat.isFile()||stat.nlink!==1))throw Error();
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  return file;
}
function runtime(env){
  return {ffmpeg:trustedFile('/usr/bin/ffmpeg'),prlimit:trustedFile('/usr/bin/prlimit'),flock:trustedFile('/usr/bin/flock'),
    binary:trustedFile(env.DOT_BRIDGE_WHISPER_BINARY),model:trustedFile(env.DOT_BRIDGE_WHISPER_MODEL)};
}
function lockFile(env){
  const directory=env.BRIDGE_LOCK_DIRECTORY;
  if(typeof directory!=='string'||!path.isAbsolute(directory)||fs.realpathSync(directory)!==directory)throw Error();
  const parent=fs.lstatSync(directory);
  if(!parent.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o077))throw Error();
  const fd=fs.openSync(path.join(directory,'voice-transcription.lock'),fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error();}
  catch(error){fs.closeSync(fd);throw error;}
  return {fd,close:()=>fs.closeSync(fd)};
}
function run(command,args,input,{limit,timeout,fd}){
  return new Promise((resolve,reject)=>{
    let child,failed=false,size=0;const chunks=[];
    const stop=()=>{failed=true;child?.kill('SIGKILL');};
    const timer=setTimeout(stop,timeout);
    try{
      child=spawn(command,args,{shell:false,windowsHide:true,cwd:'/',stdio:['pipe','pipe','pipe',...(fd===undefined?[]:[fd])],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
      try{if(child.pid)setPriority(child.pid,10);}catch{/* CPU and memory limits still apply. */}
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limit){chunk.fill(0);stop();}else chunks.push(chunk);});
      child.stderr.on('data',chunk=>chunk.fill(0));child.stdin.on('error',()=>{});
      child.once('error',()=>{failed=true;});
      child.once('close',code=>{
        clearTimeout(timer);
        if(failed||code!==0){chunks.forEach(chunk=>chunk.fill(0));reject(Error('Local transcription unavailable'));}
        else{const output=Buffer.concat(chunks);chunks.forEach(chunk=>chunk.fill(0));resolve(output);}
      });
      child.stdin.end(input);
    }catch{clearTimeout(timer);stop();reject(Error('Local transcription unavailable'));}
  });
}
function wave(pcm){
  const output=Buffer.alloc(44+pcm.length);output.write('RIFF',0);output.writeUInt32LE(output.length-8,4);output.write('WAVEfmt ',8);
  output.writeUInt32LE(16,16);output.writeUInt16LE(1,20);output.writeUInt16LE(1,22);output.writeUInt32LE(16000,24);output.writeUInt32LE(32000,28);
  output.writeUInt16LE(2,32);output.writeUInt16LE(16,34);output.write('data',36);output.writeUInt32LE(pcm.length,40);pcm.copy(output,44);return output;
}

// Code-only injection supports offline tests. Remote tool arguments cannot select
// programs, model paths, subprocess options, files, or network destinations.
export function createAudioTranscriber({env=process.env,platform=process.platform,validate=runtime,lock=lockFile,execute=run}={}){
  let active=false;
  return async(bytes,{authorize=()=>{},deadline=Date.now()+35000}={})=>{
    authorize();
    if(env.DOT_BRIDGE_AUDIO_TRANSCRIPTION!=='local-whisper'||platform!=='linux'||active)return unavailable();
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>INPUT_LIMIT)return unavailable();
    let pcm,wav,output,guard;active=true;
    try{
      const tools=validate(env);guard=lock(env);authorize();
      const budget=max=>{const remaining=Math.min(max,deadline-Date.now());if(remaining<1000)throw Error();return remaining;};
      pcm=await execute(tools.prlimit,['--as=536870912','--cpu=6','--core=0','--fsize=0','--',tools.ffmpeg,'-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-i','pipe:0','-t','121','-vn','-map_metadata','-1','-threads','1','-ar','16000','-ac','1','-c:a','pcm_s16le','-f','s16le','pipe:1'],bytes,{limit:PCM_LIMIT+32000,timeout:budget(6000)});
      if(!pcm.length||pcm.length>PCM_LIMIT||pcm.length%2)throw Error();
      // Avoid transcribing digital silence into a hallucinated sentence.
      let energy=0;for(let i=0;i<pcm.length;i+=2){const sample=pcm.readInt16LE(i);energy+=sample*sample;}
      if(Math.sqrt(energy/(pcm.length/2))<10)return unavailable();
      wav=wave(pcm);authorize();
      // An explicit unused output basename keeps the CLI's stdout transcript
      // callback enabled for stdin input; no output-file format is requested.
      output=await execute(tools.flock,['--no-fork','--nonblock','/proc/self/fd/3',tools.prlimit,'--as=1610612736','--cpu=28','--core=0','--fsize=0','--',tools.binary,'--model',tools.model,'--file','-','--output-file','/dev/null','--language','auto','--threads','1','--no-prints','--no-timestamps'],wav,{limit:TEXT_LIMIT*4,timeout:budget(28000),fd:guard.fd});
      authorize();
      const text=new TextDecoder('utf-8',{fatal:true}).decode(output).trim();
      if(!text||text.length>TEXT_LIMIT||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/u.test(text))return unavailable();
      return {extracted_text:text,extraction_status:'complete'};
    }catch(error){if(error?.code===-32012)throw error;return unavailable();}
    finally{pcm?.fill(0);wav?.fill(0);output?.fill(0);try{guard?.close();}finally{active=false;}}
  };
}
export const transcribeAudio=createAudioTranscriber();

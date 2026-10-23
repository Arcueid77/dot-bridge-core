import {Worker} from 'node:worker_threads';

const LIMIT=8*1024*1024;
const unavailable=()=>new Error('SILK audio conversion unavailable');

// The decoder URL is selected by trusted provider code via import.meta.resolve,
// never by a message, tool argument or environment setting. Providers pin the
// codec package; core remains independent of provider SDKs and optional codecs.
export function validatePcmWav(input) {
  if(!Buffer.isBuffer(input)||input.length<44||input.length>LIMIT||input.toString('ascii',0,4)!=='RIFF'||input.toString('ascii',8,12)!=='WAVE'||input.readUInt32LE(4)!==input.length-8)throw unavailable();
  let format,data,offset=12;
  while(offset+8<=input.length){
    const id=input.toString('ascii',offset,offset+4),length=input.readUInt32LE(offset+4),start=offset+8,end=start+length;
    if(end>input.length)throw unavailable();
    if(id==='fmt '){if(format||length<16)throw unavailable();format={code:input.readUInt16LE(start),channels:input.readUInt16LE(start+2),rate:input.readUInt32LE(start+4),byteRate:input.readUInt32LE(start+8),align:input.readUInt16LE(start+12),bits:input.readUInt16LE(start+14)};}
    if(id==='data'){if(data)throw unavailable();data={offset:start,length};}
    offset=end+(length%2);
  }
  if(offset!==input.length||!format||!data||format.code!==1||format.channels!==1||format.bits!==16||format.align!==2||format.byteRate!==format.rate*2||![8000,12000,16000,24000,32000,44100,48000].includes(format.rate)||!data.length||data.length%2||data.length/format.byteRate>120)throw unavailable();
  return {...data,sampleRate:format.rate};
}

function createCodec(mode,decoderUrl,{WorkerClass=Worker,timeoutMs=10000}={}) {
  const url=new URL(decoderUrl);
  if(url.protocol!=='file:'||url.search||url.hash)throw unavailable();
  return (input,{signal}={})=>new Promise((resolve,reject)=>{
    if(!Buffer.isBuffer(input)||!input.length||input.length>LIMIT||signal?.aborted){reject(unavailable());return;}
    if(mode==='encode'){try{validatePcmWav(input);}catch{reject(unavailable());return;}}
    let settled=false,timer,worker;
    const finish=(bytes)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker?.terminate();
      if(!(bytes instanceof Uint8Array)||bytes.length<(mode==='encode'?10:44)||bytes.length>LIMIT){reject(unavailable());return;}
      const output=Buffer.from(bytes);
      if(mode==='encode'?!output.subarray(0,16).includes(Buffer.from('#!SILK_V3')):output.toString('ascii',0,4)!=='RIFF'||output.toString('ascii',8,12)!=='WAVE'){output.fill(0);reject(unavailable());return;}
      resolve(output);
    };
    const abort=()=>finish(null);
    try{
      worker=new WorkerClass(new URL('./silk-worker.js',import.meta.url),{workerData:{input:Uint8Array.from(input),decoderUrl:url.href,mode},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
      worker.stdout?.resume();worker.stderr?.resume();
      timer=setTimeout(()=>finish(null),Math.min(10000,Math.max(1,timeoutMs)));
      signal?.addEventListener('abort',abort,{once:true});
      worker.once('message',finish);worker.once('error',()=>finish(null));worker.once('exit',()=>finish(null));
      if(signal?.aborted)abort();
    }catch{finish(null);}
  });
}
export const createSilkDecoder=(url,options)=>createCodec('decode',url,options);
export const createSilkEncoder=(url,options)=>createCodec('encode',url,options);

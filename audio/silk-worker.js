import {parentPort,workerData} from 'node:worker_threads';
import {validatePcmWav} from './silk.js';

const maxDuration=120000,rate=24000;
let input=Buffer.from(workerData.input),pcm;
try{
  const {decode,encode,isSilk,getDuration}=await import(workerData.decoderUrl);
  if(workerData.mode==='encode'){
    const info=validatePcmWav(input),result=await encode(input.subarray(info.offset,info.offset+info.length),info.sampleRate);
    if(!isSilk(result.data)||!result.data.length||result.data.length>8*1024*1024||!Number.isFinite(result.duration)||result.duration<=0||result.duration>maxDuration)throw Error();
    const output=Uint8Array.from(result.data);result.data.fill(0);parentPort.postMessage(output,[output.buffer]);
  }else{
  if(input.toString('ascii',0,6)==='#!AMR\n')input=input.subarray(6);
  if(!isSilk(input))throw Error();
  const duration=getDuration(input);
  if(!Number.isFinite(duration)||duration<=0||duration>maxDuration)throw Error();
  const result=await decode(input,rate);pcm=result.data;
  if(!pcm.length||pcm.length%2||pcm.length>rate*2*maxDuration/1000||!Number.isFinite(result.duration)||result.duration>maxDuration)throw Error();
  const wav=new Uint8Array(44+pcm.length),header=Buffer.from(wav.buffer);
  header.write('RIFF',0);header.writeUInt32LE(wav.length-8,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);wav.set(pcm,44);
  parentPort.postMessage(wav,[wav.buffer]);
  }
}catch{parentPort.postMessage(null);}
finally{input.fill(0);workerData.input.fill(0);pcm?.fill(0);}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioTranscriber} from '../audio/transcription.js';
const env={DOT_BRIDGE_AUDIO_TRANSCRIPTION:'local-whisper'},tools={ffmpeg:'/trusted/ffmpeg',prlimit:'/trusted/prlimit',flock:'/trusted/flock',binary:'/trusted/whisper',model:'/trusted/model',guard:'/trusted/no-core-dump.so'};
const pcm=()=>{const b=Buffer.alloc(3200);for(let i=0;i<b.length;i+=2)b.writeInt16LE(200,i);return b;};
function fixture(overrides={}){const calls=[],buffers=[];let closed=0;
 const execute=async(command,args,input,options)=>{calls.push({command,args,options});const result=command===tools.prlimit?pcm():Buffer.from('合成语音转写');buffers.push(result);return result;};
 const read=createAudioTranscriber({env,platform:'linux',validate:()=>tools,lock:()=>({fd:9,close:()=>closed++}),execute,...overrides});
 return {read,calls,buffers,closed:()=>closed};
}
test('voice transcription uses only protected local processes, bounded pipes and a shared nonblocking lock',async()=>{
 const f=fixture();let checks=0;const result=await f.read(Buffer.from('synthetic audio'),{authorize:()=>checks++});
 assert.deepEqual(result,{extracted_text:'合成语音转写',extraction_status:'complete'});assert.ok(checks>=4);
 assert.equal(f.calls.length,2);assert.ok(f.calls[0].args.includes('pipe'));assert.ok(f.calls[1].args.includes('/proc/self/fd/3'));
 assert.ok(f.calls[1].args.includes('--no-fork'));assert.equal(f.calls[1].options.fd,9);assert.equal(f.closed(),1);
 assert.ok(f.calls.every(call=>call.args.includes('--core=0')&&call.options.guard===tools.guard));
 assert.ok(f.buffers.every(b=>b.every(value=>value===0)));
});
test('transcription is opt-in, Linux-only, size bounded and never opens a runtime when disabled',async()=>{
 for(const options of [{env:{}},{platform:'win32'}]){const f=fixture({...options,validate:()=>assert.fail()});assert.equal((await f.read(Buffer.from('a'))).extraction_status,'unsupported');}
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(8*1024*1024+1)]){const f=fixture({validate:()=>assert.fail()});assert.equal((await f.read(bytes)).extraction_status,'unsupported');}
});
test('untrusted runtime, subprocess failures and malformed output have no private error details',async()=>{
 for(const overrides of [{validate:()=>{throw Error('private runtime path');}},{execute:async()=>{throw Error('private bytes');}},
 {execute:async cmd=>cmd===tools.prlimit?pcm():Buffer.from([0xff])}]){const f=fixture(overrides);assert.deepEqual(await f.read(Buffer.from('a')),{extraction_status:'unsupported'});}
});
test('silence and oversized duration never reach speech recognition',async()=>{
 for(const data of [Buffer.alloc(3200),Buffer.alloc(16000*2*121)]){let calls=0;const f=fixture({execute:async()=>{calls++;return data;}});assert.equal((await f.read(Buffer.from('a'))).extraction_status,'unsupported');assert.equal(calls,1);}
});
test('revocation before or during transcription remains an authorization error and closes resources',async()=>{
 for(const after of [1,3,4]){let count=0;const f=fixture();await assert.rejects(f.read(Buffer.from('a'),{authorize:()=>{if(++count===after)throw Object.assign(Error('revoked'),{code:-32012});}}),e=>e.code===-32012);assert.equal(f.closed(),after===1?0:1);}
});
test('concurrent calls and exhausted deadlines return unavailable without queuing more CPU work',async()=>{
 let release;const f=fixture({execute:()=>new Promise(resolve=>release=resolve)});
 const first=f.read(Buffer.from('a'));assert.equal((await f.read(Buffer.from('a'))).extraction_status,'unsupported');release(Buffer.alloc(2));await first;
 const other=fixture();assert.equal((await other.read(Buffer.from('a'),{deadline:Date.now()-1})).extraction_status,'unsupported');assert.equal(other.calls.length,0);
});

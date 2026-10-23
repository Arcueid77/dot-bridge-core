import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSilkDecoder,createSilkEncoder,validatePcmWav} from '../audio/silk.js';

function codec(t,source){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dotbridge-codec-test-')),file=path.join(dir,'codec.mjs');fs.writeFileSync(file,source);
 t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});return pathToFileURL(file).href;
}
test('optional codec is isolated, converts bounded PCM into WAV and leaves input unchanged',async t=>{
 const url=codec(t,'export const isSilk=()=>true; export const getDuration=()=>20; export const decode=async()=>({data:new Uint8Array(960),duration:20});');
 const input=Buffer.from('synthetic silk');const output=await createSilkDecoder(url)(input);
 assert.equal(output.toString('ascii',0,4),'RIFF');assert.equal(output.toString('ascii',8,12),'WAVE');assert.equal(output.readUInt32LE(24),24000);assert.equal(output.length,1004);assert.equal(input.toString(),'synthetic silk');
});
test('untrusted codec URL, non-SILK, long audio and aborted work are refused',async t=>{
 assert.throws(()=>createSilkDecoder('https://example.com/codec.js'));
 for(const source of ['export const isSilk=()=>false;', 'export const isSilk=()=>true; export const getDuration=()=>120001;'])await assert.rejects(createSilkDecoder(codec(t,source))(Buffer.from('bad')));
 const controller=new AbortController();controller.abort();await assert.rejects(createSilkDecoder(codec(t,''))(Buffer.from('bad'),{signal:controller.signal}));
});
test('a hanging codec is terminated within the configured budget',async t=>{
 const url=codec(t,'export const isSilk=()=>true; export const getDuration=()=>20; export const decode=async()=>{while(true){}};');
 const started=Date.now();await assert.rejects(createSilkDecoder(url,{timeoutMs:100})(Buffer.from('synthetic')));assert.ok(Date.now()-started<3000);
});

function wav(){const data=Buffer.alloc(44+960);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(24000,24);data.writeUInt32LE(48000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(960,40);return data;}
test('native voice encoding validates PCM WAV before entering the bounded codec',async t=>{
 const url=codec(t,'export const isSilk=()=>true; export const encode=async(pcm,rate)=>{if(pcm.length!==960||rate!==24000)throw Error();return {data:new TextEncoder().encode("#!SILK_V3fixture"),duration:20};};');
 const input=wav(),copy=Buffer.from(input);assert.deepEqual(validatePcmWav(input),{offset:44,length:960,sampleRate:24000});
 const encoded=await createSilkEncoder(url)(input);assert.equal(encoded.toString(),'#!SILK_V3fixture');assert.deepEqual(input,copy);
 for(const position of [4,20,22,24,28,32,34,40]){const invalid=Buffer.from(input);invalid[position]^=7;assert.throws(()=>validatePcmWav(invalid));await assert.rejects(createSilkEncoder(url)(invalid));}
 const falseCodec=codec(t,'export const isSilk=()=>true; export const encode=async()=>({data:new Uint8Array(12),duration:20});');await assert.rejects(createSilkEncoder(falseCodec)(input));
});

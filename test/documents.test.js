import test from 'node:test';
import assert from 'node:assert/strict';
import {extractDocumentText} from '../channels/documents.js';
import {MAX_MEDIA_BYTES} from '../channels/tunnel-budget.js';

test('passive text extraction accepts UTF-8 and BOM-marked UTF-16 without changing source bytes',()=>{
 const text='A small note\n一份说明 🙂\t';
 const le=Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]);
 const be=Buffer.from(le);be.swap16();
 for(const bytes of [Buffer.from(text),Buffer.concat([Buffer.from([239,187,191]),Buffer.from(text)]),le,be]){
  const original=Buffer.from(bytes);
  assert.deepEqual(extractDocumentText(bytes),{extraction_status:'complete',extracted_text:text});
  assert.deepEqual(bytes,original);
 }
});

test('text prefixes are explicitly truncated and never split a surrogate pair',()=>{
 const bytes=Buffer.from('abc🙂rest');
 assert.deepEqual(extractDocumentText(bytes,{maxCharacters:4}),{extraction_status:'truncated',extracted_text:'abc'});
 assert.deepEqual(extractDocumentText(bytes,{maxCharacters:5}),{extraction_status:'truncated',extracted_text:'abc🙂'});
 assert.deepEqual(extractDocumentText(Buffer.from('exact'),{maxCharacters:5}),{extraction_status:'complete',extracted_text:'exact'});
});

test('binary, malformed and control-bearing files do not masquerade as readable text',()=>{
 for(const bytes of [Buffer.from('%PDF-1.7 printable PDF syntax'),Buffer.from('PK fake archive'),Buffer.from([0xff,0x80]),Buffer.from('note\0private'),Buffer.from('note\x7fprivate'),Buffer.from([255,254,65]),Buffer.alloc(0)]){
  assert.deepEqual(extractDocumentText(bytes),{extraction_status:'unsupported'});
 }
 assert.deepEqual(extractDocumentText(Buffer.from('printable audio header'),{mimeType:'audio/mpeg'}),{extraction_status:'unsupported'});
});

test('text extraction enforces the source byte and output character budgets',()=>{
 assert.equal(extractDocumentText(Buffer.alloc(MAX_MEDIA_BYTES,65)).extracted_text.length,12000);
 assert.deepEqual(extractDocumentText(Buffer.alloc(MAX_MEDIA_BYTES+1,65)),{extraction_status:'unsupported'});
 for(const limit of [0,-1,30001,1.5])assert.deepEqual(extractDocumentText(Buffer.from('x'),{maxCharacters:limit}),{extraction_status:'unsupported'});
});

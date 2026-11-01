import {MAX_MEDIA_BYTES} from './tunnel-budget.js';

// Decode passive text only. Other documents remain available as original
// attachments; no parser process, archive expansion or network is involved.
export function extractDocumentText(bytes,{mimeType='application/octet-stream',maxCharacters=12000}={}) {
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA_BYTES||typeof mimeType!=='string'||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>30000)return {extraction_status:'unsupported'};
 if(mimeType==='application/pdf'||/^(?:image|audio|video)\//u.test(mimeType)||bytes.subarray(0,5).toString('ascii')==='%PDF-'||bytes.subarray(0,2).toString('ascii')==='PK')return {extraction_status:'unsupported'};
 try{
  let encoding='utf-8';
  if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';
  else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
  const text=new TextDecoder(encoding,{fatal:true}).decode(bytes);
  if(!text.length||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/u.test(text))return {extraction_status:'unsupported'};
  let extracted=text.slice(0,maxCharacters);
  if(/[\uD800-\uDBFF]$/u.test(extracted))extracted=extracted.slice(0,-1);
  if(!extracted)return {extraction_status:'unsupported'};
  return {extraction_status:extracted.length<text.length?'truncated':'complete',extracted_text:extracted};
 }catch{return {extraction_status:'unsupported'};}
}

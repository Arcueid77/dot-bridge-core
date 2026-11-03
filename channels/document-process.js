import {fileURLToPath} from 'node:url';
import {extractDocumentText} from './documents.js';
import {protectedMediaProcess} from '../audio/media-process.js';
import {assertTrustedRuntimeFile} from '../audio/transcription.js';

export function createDocumentReader({execute=protectedMediaProcess,trusted=assertTrustedRuntimeFile}={}) {
  return async function readableDocument(bytes,{mimeType='',maxCharacters=12000,authorize=()=>{},deadline=Date.now()+20000}={}) {
    let output;
    try {
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>5*1024*1024||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>30000)return {extraction_status:'unsupported'};
      authorize();
      const pdf=bytes.subarray(0,5).toString()==='%PDF-',office=bytes.subarray(0,2).toString()==='PK';
      if(!pdf&&!office)return extractDocumentText(bytes,{mimeType,maxCharacters});
      const worker=trusted(fileURLToPath(new URL('../audio/read-document.py',import.meta.url)));
      const timeout=Math.min(20000,deadline-Date.now());if(timeout<=0)throw Error('Document deadline passed');
      output=await execute('python3',['-I','-B',worker,pdf?'pdf':'office'],bytes,{limit:300000,timeout});authorize();
      const value=JSON.parse(output.toString('utf8'));
      if(!['complete','truncated','unsupported'].includes(value.status)||typeof value.text!=='string'||value.text.length>30000||!value.text.isWellFormed())throw Error('Invalid bounded document result');
      let text='';for(const character of value.text){if(text.length+character.length>maxCharacters)break;text+=character;}
      return {extraction_status:text?(value.status==='truncated'||value.text.length>maxCharacters?'truncated':'complete'):'unsupported',...(text?{extracted_text:text}:{})};
    } catch {authorize();return {extraction_status:'unsupported'};}
    finally {output?.fill(0);}
  };
}
export const readableDocument=createDocumentReader();

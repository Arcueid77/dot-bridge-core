import test from 'node:test';
import assert from 'node:assert/strict';
import {telegramHTML,splitTelegramHTML,splitMarkdown} from '../channels/formatting.js';
import {createDocumentReader} from '../channels/document-process.js';

test('Telegram Markdown conversion escapes HTML and supports bounded safe formatting',()=>{
  const value=telegramHTML('## title\n\n**bold** and _italic_\n\n<script>alert(1)</script>\n\n[site](https://example.com/?q=%22x%22&ok=1)\n\n```js\nconst x = "<tag>";\n```');
  assert.match(value.html,/<b>title<\/b>/);assert.match(value.html,/<b>bold<\/b>/);assert.match(value.html,/<i>italic<\/i>/);assert.equal(value.html.includes('<script>'),false);assert.match(value.html,/&lt;script&gt;/);assert.match(value.html,/<pre>/);assert.equal(value.html.includes('onclick='),false);
  assert.match(value.plain,/<script>alert/);
});
test('HTML chunks stay balanced and never split an entity or UTF-16 pair',()=>{
  const source=telegramHTML('**'+('🙂 & <x> '.repeat(2000)).trimEnd()+'**');
  const parts=splitTelegramHTML(source.html,4000);assert.ok(parts.length>2);
  for(const part of parts){assert.equal(part.isWellFormed(),true);assert.match(part,/^<b>/);assert.match(part,/<\/b>$/);const plain=part.replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot);/g,'x');assert.ok(plain.length<=4000);}
  assert.equal(parts.join('').replace(/<[^>]*>/g,''),source.html.replace(/<[^>]*>/g,''));
});
test('native Markdown chunking preserves every original Unicode character in order',()=>{
  const text=('a paragraph 🙂\n\n').repeat(500);const parts=splitMarkdown(text,1900);assert.equal(parts.join(''),text);for(const part of parts){assert.ok(part.length<=1900);assert.ok(part.isWellFormed());}
});
test('native Markdown chunks reopen long code fences without exceeding the platform budget',()=>{
  const text='```js\n'+('const x = "🙂";\n'.repeat(500))+'```';const parts=splitMarkdown(text,1900);assert.ok(parts.length>2);
  for(const part of parts){assert.ok(part.length<=1900);assert.ok(part.isWellFormed());assert.equal((part.match(/^```/gm)??[]).length,2);}
});
test('shared document extraction uses a bounded trusted pipe and rechecks authorization',async()=>{
  let calls=0,authorizations=0;
  const read=createDocumentReader({trusted:file=>file,execute:async(name,args,input,options)=>{calls++;assert.equal(name,'python3');assert.ok(args.includes('office'));assert.ok(options.timeout<=20000);assert.equal(input.subarray(0,2).toString(),'PK');return Buffer.from(JSON.stringify({status:'complete',text:'x'.repeat(13000)}));}});
  const result=await read(Buffer.from('PK synthetic office'),{mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',authorize:()=>{authorizations++;}});
  assert.equal(calls,1);assert.equal(result.extraction_status,'truncated');assert.equal(result.extracted_text.length,12000);assert.equal(authorizations,2);
  assert.equal((await read(Buffer.from('UTF-8 text'),{mimeType:'text/plain'})).extracted_text,'UTF-8 text');assert.equal(calls,1);
});
test('document revocation after extraction is not converted into a usable excerpt',async()=>{
  let allowed=true;const read=createDocumentReader({trusted:file=>file,execute:async()=>{allowed=false;return Buffer.from('{"status":"complete","text":"private"}');}});
  await assert.rejects(read(Buffer.from('%PDF-synthetic'),{authorize:()=>{if(!allowed)throw Error('revoked');}}),/revoked/);
});

test('Markdown tables stay with their headers and oversized tables repeat headers on row boundaries',()=>{
  const header='| name | state |\n| --- | --- |\n';
  const table=header+Array.from({length:40},(_,index)=>`| row-${index} | done |\n`).join('');
  const parts=splitMarkdown(table,240);
  assert.ok(parts.length>2);
  for(const part of parts){assert.ok(part.startsWith(header));assert.ok(part.length<=240);assert.match(part,/\|\n$/);}
  for(let index=0;index<40;index++)assert.equal(parts.join('').split(`| row-${index} |`).length-1,1);
  const short=header+'| short | done |\n';
  const grouped=splitMarkdown('intro\n\n'+short+'\nending',240);
  assert.ok(grouped.some(part=>part.includes(short)));
});

test('Markdown boundaries prefer paragraphs and preserve joined emoji when they fit the platform budget',()=>{
  const family='👩‍👩‍👧‍👦';
  const text=('paragraph '+family+' words\n\n').repeat(25);
  const parts=splitMarkdown(text,190);
  assert.equal(parts.join(''),text);
  for(const part of parts){assert.ok(part.length<=190);assert.equal(part.startsWith('\u200d'),false);assert.equal(part.endsWith('\u200d'),false);}
});

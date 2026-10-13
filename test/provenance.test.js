import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
test('extraction inventory preserves shared runtime source and reviewed test/doc changes',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('provenance/extraction.json',root),'utf8'));
 assert.match(manifest.source_revision,/^[a-f0-9]{40}$/);const seen=new Set();
 for(const item of manifest.files){assert.match(item.file,/^packages\/dot-bridge-(?:transport|platform)\/[a-z0-9._/-]+$/i);assert.equal(item.file.includes('..'),false);assert.equal(seen.has(item.file),false);seen.add(item.file);
  const file=new URL(item.file,root);assert.equal(fs.lstatSync(file).isFile(),true);assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),item.sha256);
  if(item.adaptation){assert.match(item.source_sha256,/^[a-f0-9]{64}$/);if(item.file.endsWith('/private-files.js')){
    const text=fs.readFileSync(file,'utf8');assert.match(text.split('\n')[2],/from '\.\/index.js'/);assert.equal(createHash('sha256').update(text.split('\n').slice(3).join('\n')).digest('hex'),item.source_body_sha256);
  }else assert.ok(item.file.endsWith('README.md')||item.file.includes('/test/'));}
 }
 const actual=[];for(const packageName of ['dot-bridge-transport','dot-bridge-platform'])for(const file of fs.readdirSync(new URL(`packages/${packageName}/`,root),{recursive:true}))if(fs.lstatSync(new URL(`packages/${packageName}/${file.replaceAll('\\','/')}`,root)).isFile())actual.push(`packages/${packageName}/${file.replaceAll('\\','/')}`);
 assert.deepEqual(actual.sort(),[...seen].sort());
});
test('distribution has explicit public files, no provider dependencies or sibling imports',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8'));assert.equal(pkg.dependencies,undefined);assert.equal(pkg.devDependencies,undefined);
 assert.equal(pkg.files.some(file=>/\.env|credentials|sqlite|\.git|dot-(?:qq|lark)-bridge/.test(file)),false);
 for(const file of fs.readdirSync(new URL('router/',root)))assert.equal(/from\s+['"][^'"]*(?:dot-(?:qq|lark)-bridge|lark-contract)/.test(fs.readFileSync(new URL(`router/${file}`,root),'utf8')),false);
});

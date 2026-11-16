import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gitRevision,packageRuntime,catalogFingerprint,runtimeInfo} from '../router/runtime.js';

test('runtime metadata recognizes detached Git worktrees and exported source revisions',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-public-metadata-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const sha='a'.repeat(40);
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'dot-bridge',version:'0.10.0'}));
  fs.writeFileSync(path.join(directory,'source-revision.txt'),sha+'\n');
  assert.equal(packageRuntime(directory).revision,sha);
  assert.equal(packageRuntime(directory).source_kind,'archive');
  fs.mkdirSync(path.join(directory,'metadata'));
  fs.writeFileSync(path.join(directory,'.git'),'gitdir: metadata\n');
  fs.writeFileSync(path.join(directory,'metadata','HEAD'),'b'.repeat(40)+'\n');
  assert.equal(gitRevision(directory),'b'.repeat(40));
  fs.writeFileSync(path.join(directory,'metadata','HEAD'),'ref: refs/../../outside\n');
  assert.equal(gitRevision(directory),null);
  assert.equal(Object.hasOwn(runtimeInfo(),'path'),false);
});

test('catalog fingerprints preserve schema differences and ignore directory ordering',()=>{
  const a={name:'a',inputSchema:{type:'object',properties:{x:{type:'string'}}}},b={name:'b'};
  assert.equal(catalogFingerprint([a,b],[]),catalogFingerprint([b,a],[]));
  assert.notEqual(catalogFingerprint([a],[]),catalogFingerprint([{...a,inputSchema:{type:'object'}}],[]));
});

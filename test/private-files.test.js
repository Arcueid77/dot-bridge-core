import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPrivateDirectory,readPrivateFile,privateDatabasePath} from '../packages/dot-bridge-platform/private-files.js';
import {privateMkdtempSync,cleanupPrivateFixture,fixtureChmodSync} from '../packages/dot-bridge-platform/test-fixtures.js';
import {windowsWritePrivateFile} from '../packages/dot-bridge-platform/index.js';
function fixture(t){const directory=privateMkdtempSync(path.join(os.tmpdir(),'core-private-files-test-'));cleanupPrivateFixture(t,directory);const file=path.join(directory,'synthetic');if(process.platform==='win32')windowsWritePrivateFile(file,Buffer.from('synthetic'));else fs.writeFileSync(file,'synthetic',{mode:0o600});return {directory,file};}
test('canonical private-file API reads bounded owner files and pins database parent',t=>{
 const f=fixture(t);assert.equal(readPrivateFile(f.file,{exactBytes:9}).toString(),'synthetic');assert.throws(()=>readPrivateFile(f.file,{maxBytes:8}));
 const parent=openPrivateDirectory(f.directory);parent.close();const db=privateDatabasePath(f.file);assert.equal(fs.readFileSync(db.path,'utf8'),'synthetic');db.close();
});
test('canonical private-file API rejects hardlinks for reads and database sidecars',t=>{
 const f=fixture(t),alias=path.join(f.directory,'linked');fs.linkSync(f.file,alias);assert.throws(()=>readPrivateFile(f.file));assert.throws(()=>privateDatabasePath(f.file));
});
test('canonical private-file API refuses widened private file permissions',t=>{
 const f=fixture(t);fixtureChmodSync(f.file,0o644);assert.throws(()=>readPrivateFile(f.file));assert.throws(()=>privateDatabasePath(f.file));
});

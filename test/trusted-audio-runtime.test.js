import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertTrustedRuntimeFile} from '../audio/transcription.js';

test('media conversion shares protected root-owned executable and guard validation',{skip:process.platform!=='linux'},t=>{
 const executable=fs.realpathSync('/usr/bin/true');assert.equal(assertTrustedRuntimeFile(executable),executable);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dotbridge-runtime-trust-')),file=path.join(directory,'guard.so');fs.writeFileSync(file,'synthetic');
 t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(directory);});
 for(const value of [undefined,'relative.so',file,path.dirname(executable),'/usr/bin/../bin/true'])assert.throws(()=>assertTrustedRuntimeFile(value));
});

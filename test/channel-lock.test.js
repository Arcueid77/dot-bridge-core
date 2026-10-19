import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {channelLock} from '../channels/lock.js';
import {hash} from '../channels/store.js';

const linux={skip:process.platform!=='linux',timeout:20000};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dot-channel-lock-'));fs.chmodSync(directory,0o700);
 const config={channel:{id:'fixture'},credentials:{ownerId:'synthetic-owner',conversationId:'synthetic-private'},bridgeLockDirectory:directory};
 const filename=`${hash('fixture:synthetic-owner:synthetic-private')}.lock`;
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 return {directory,config,filename,file:path.join(directory,filename)};
}
function consumer(config){
 const moduleUrl=new URL('../channels/lock.js',import.meta.url).href;
 const source=`import {channelLock} from ${JSON.stringify(moduleUrl)};
const release=await channelLock(JSON.parse(process.env.DOT_LOCK_FIXTURE));
process.stdout.write('consumer-ready\\n');
setInterval(()=>{},1000);`;
 return spawn(process.execPath,['--input-type=module','--eval',source],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,DOT_LOCK_FIXTURE:JSON.stringify(config)},stdio:['ignore','pipe','pipe']});
}
function ready(child){return new Promise((resolve,reject)=>{
 let output='';
 const timer=setTimeout(()=>{cleanup();reject(new Error('Fixture consumer did not acquire lock'));},8000);
 const data=chunk=>{output+=chunk.toString('utf8');if(output.includes('consumer-ready\n')){cleanup();resolve();}};
 const exit=()=>{cleanup();reject(new Error('Fixture consumer exited before lock acquisition'));};
 const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',data);child.off('exit',exit);};
 child.stdout.on('data',data);child.once('exit',exit);child.once('error',exit);
});}
async function kill(child){if(child.exitCode!==null||child.signalCode!==null)return;const closed=once(child,'close');child.kill('SIGKILL');await closed;}

test('Linux live consumer is exclusive and release preserves the private inode',linux,async t=>{
 const f=fixture(t),release=await channelLock(f.config);t.after(release);
 const held=fs.statSync(f.file);assert.equal(held.mode&0o7777,0o600);
 await assert.rejects(channelLock(f.config),{message:'Channel lock is unavailable, unsafe or already held'});
 await release();await release();
 const persisted=fs.statSync(f.file);assert.equal(persisted.ino,held.ino);
 const second=await channelLock(f.config);await second();assert.equal(fs.statSync(f.file).ino,held.ino);
});

test('Linux killed consumer releases the advisory lock without deleting its lockfile',linux,async t=>{
 const f=fixture(t),child=consumer(f.config);t.after(()=>kill(child));await ready(child);
 const inode=fs.statSync(f.file).ino;
 await assert.rejects(channelLock(f.config));await kill(child);
 let release;
 for(let attempt=0;attempt<40&&!release;attempt++){
  try{release=await channelLock(f.config);}catch{await new Promise(resolve=>setTimeout(resolve,25));}
 }
 assert.equal(typeof release,'function');t.after(()=>release?.());assert.equal(fs.statSync(f.file).ino,inode);await release();
});

test('Linux unsafe lock targets fail closed without modifying the linked file',linux,async t=>{
 const f=fixture(t),target=path.join(f.directory,'other-file');fs.writeFileSync(target,'fixture-original',{mode:0o600});
 fs.symlinkSync(target,f.file);await assert.rejects(channelLock(f.config));assert.equal(fs.readFileSync(target,'utf8'),'fixture-original');fs.unlinkSync(f.file);
 fs.linkSync(target,f.file);await assert.rejects(channelLock(f.config));assert.equal(fs.readFileSync(target,'utf8'),'fixture-original');fs.unlinkSync(f.file);
 fs.writeFileSync(f.file,'fixture-original',{mode:0o644});await assert.rejects(channelLock(f.config));assert.equal(fs.readFileSync(f.file,'utf8'),'fixture-original');
});

test('Linux unexpected helper loss notifies the consumer and frees its lock',linux,async t=>{
 const f=fixture(t);let lost;const notification=new Promise(resolve=>{lost=resolve;});
 const release=await channelLock(f.config,{onLost:lost});t.after(release);
 // Only the fixed no-fork cat child of this synthetic consumer is targeted.
 let helpers=[];
 for(let attempt=0;attempt<40&&!helpers.length;attempt++){
  const children=fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean);
  helpers=children.filter(pid=>{try{return fs.readFileSync(`/proc/${pid}/comm`,'utf8').trim()==='cat';}catch{return false;}});
  if(!helpers.length)await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(helpers.length,1);process.kill(Number(helpers[0]),'SIGKILL');await notification;await release();
 const next=await channelLock(f.config);await next();
});

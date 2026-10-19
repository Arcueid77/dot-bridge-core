import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {assertPrivateFile,openPrivateDirectory} from '../packages/dot-bridge-platform/private-files.js';
import {windowsModeLock} from '../packages/dot-bridge-platform/index.js';
import {hash} from './store.js';

const refused=()=>new Error('Channel lock is unavailable, unsafe or already held');
const deadline=(promise,milliseconds)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),milliseconds);promise.then(()=>{clearTimeout(timer);resolve(true);});});

// The fixed helper owns an advisory flock for exactly as long as its stdin pipe
// remains open. --no-fork + exec avoids grandchildren that could retain the lock.
// A killed consumer closes that pipe in the kernel, so the next service can start
// without deleting or taking over an existing lock file.
export async function channelLock(config,{onLost=()=>{}}={}){
 if(typeof onLost!=='function')throw refused();
 const filename=`${hash(`${config.channel.id}:${config.credentials.ownerId}:${config.credentials.conversationId}`)}.lock`;
 const record={nonce:randomUUID(),pid:process.pid,channel:config.channel.id};
 if(process.platform==='win32'){
  const close=windowsModeLock(config.bridgeLockDirectory,filename,record);let released=false;
  return async()=>{if(released)return;released=true;close();};
 }
 if(process.platform!=='linux')throw refused();
 let parent,fd,child,releasing=false,acquired=false,exitResolve,bootResolve,bootReject,releasePromise;
 const exited=new Promise(resolve=>{exitResolve=resolve;});
 const boot=new Promise((resolve,reject)=>{bootResolve=resolve;bootReject=reject;});
 let childExited=false;
 const didExit=()=>{
  if(childExited)return;childExited=true;exitResolve();bootReject(refused());
  if(acquired&&!releasing)Promise.resolve().then(()=>onLost()).catch(()=>{});
 };
 const release=()=>releasePromise??=(async()=>{
  releasing=true;
  try{
   if(child){
    child.stdin?.end();
    if(!await deadline(exited,1500)){
     child.kill('SIGTERM');
     if(!await deadline(exited,500)){child.kill('SIGKILL');if(!await deadline(exited,1000))throw refused();}
    }
   }
  }finally{
   if(fd!==undefined){fs.closeSync(fd);fd=undefined;}
   parent?.close();parent=undefined;
  }
 })();
 try{
  parent=openPrivateDirectory(config.bridgeLockDirectory);
  const target=`${parent.path}/${filename}`;
  fd=fs.openSync(target,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
  assertPrivateFile(fs.fstatSync(fd),{maxBytes:4096});
  child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork','/proc/self/fd/3','/bin/sh','-c','printf "locked\\n"; exec /usr/bin/cat >/dev/null'],{
   cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['pipe','pipe','ignore',fd],windowsHide:true,
  });
  child.stdin.on('error',()=>{});
  child.once('error',didExit);child.once('exit',didExit);
  let output=Buffer.alloc(0);
  const data=chunk=>{
   output=Buffer.concat([output,chunk]);
   if(output.length>32){bootReject(refused());return;}
   if(output.equals(Buffer.from('locked\n')))bootResolve();
   else if(output.includes(10))bootReject(refused());
  };
  child.stdout.on('data',data);
  const timer=setTimeout(()=>bootReject(refused()),5000);
  try{await boot;}finally{clearTimeout(timer);child.stdout.off('data',data);child.stdout.resume();}
  if(childExited)throw refused();
  const held=fs.fstatSync(fd),current=fs.lstatSync(target);
  assertPrivateFile(held,{maxBytes:4096});assertPrivateFile(current,{maxBytes:4096});
  if(held.dev!==current.dev||held.ino!==current.ino)throw refused();
  fs.ftruncateSync(fd,0);fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);
  acquired=true;
  return release;
 }catch{
  // boot may reject before spawn can create a child (e.g. unsafe private path).
  // Attach a handler in that branch as well; no rejected promise is left behind.
  boot.catch(()=>{});
  await release().catch(()=>{});
  throw refused();
 }
}

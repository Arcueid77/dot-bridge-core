import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {LegacyManagement} from '../channels/legacy-management.js';

function fixture(t,{send=async()=>{},now=Date.now()}={}){
  const db=new DatabaseSync(':memory:'),key=Buffer.alloc(32,44);t.after(()=>{db.close();key.fill(0);});
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,owner TEXT,subscription_id TEXT,received INTEGER,expires INTEGER,text TEXT); CREATE TABLE replies(message_id TEXT PRIMARY KEY,digest TEXT,text TEXT,created INTEGER); CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,message_id TEXT,subscription_id TEXT,state TEXT,next_at INTEGER,last_error TEXT,lease_token TEXT,lease_until INTEGER);');
  const vault={
    seal(value,aad){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(aad));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64');},
    open(value,aad){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());},
  };
  const store={db,vault,get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),run:(sql,...args)=>db.prepare(sql).run(...args),message:id=>db.prepare('SELECT * FROM messages WHERE id=?').get(id),replyStatus:id=>({status:db.prepare("SELECT state FROM jobs WHERE id=? AND kind='reply'").get('reply:'+id)?.state??'none'}),tx(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const calls=[],options={store,channel:'Fixture',enabled:true,clock:()=>now,ownerPrivate:message=>message.owner==='owner',status:()=>({binding_ready:true,gateway_connected:true,subscription_status:{state:'none',expires_at:null}}),sendReply:async(message,text,authorize)=>{authorize();calls.push({message,text});await send();}};
  return {store,calls,create:()=>new LegacyManagement(options),message:(id,text)=>({id,owner:'owner',text,expires:now+60000})};
}

test('established stores receive durable owner control replies without changing subscriptions or dispatching events',async t=>{
  const f=fixture(t),management=f.create();let checkpoints=0;
  assert.equal(management.accept(f.message('command','/status'),()=>{checkpoints++;}),true);
  assert.equal(management.accept(f.message('command','/status'),()=>{checkpoints++;}),true);assert.equal(checkpoints,2);
  assert.equal(f.store.get('SELECT count(*) AS n FROM messages').n,0);assert.equal(f.store.get('SELECT count(*) AS n FROM jobs').n,0);
  assert.equal(await management.tick(),true);assert.equal(await management.tick(),false);assert.equal(f.calls.length,1);assert.match(f.calls[0].text,/subscription: none/);
  const encrypted=f.store.get('SELECT payload FROM bridge_management_reply').payload;assert.equal(encrypted.includes('/status'),false);assert.equal(encrypted.includes('owner'),false);
});
test('non-owner, forwarded and ordinary messages never enter the control outbox',t=>{
  const f=fixture(t),management=f.create();assert.equal(management.accept({...f.message('a','/status'),owner:'stranger'}),false);assert.equal(management.accept({...f.message('b','/cancel'),forwarded:true}),false);assert.equal(management.accept(f.message('c','normal text')),false);assert.equal(f.store.get('SELECT count(*) AS n FROM bridge_management_reply').n,0);
});
test('pending reply cancellation preserves old-code tombstones and never changes uncertain sends',async t=>{
  const f=fixture(t),management=f.create(),future=Date.now()+60000;
  f.store.run('INSERT INTO messages VALUES (?,?,?,?,?,?)','pending','owner','sub',1,future,'private pending');
  f.store.run('INSERT INTO messages VALUES (?,?,?,?,?,?)','unknown','owner','sub',2,future,'private unknown');
  f.store.run("INSERT INTO jobs(id,kind,message_id,subscription_id,state,next_at) VALUES ('reply:unknown','reply','unknown','sub','uncertain',0)");
  management.accept(f.message('cancel','/cancel'));await management.tick();
  assert.equal(management.cancelled('pending'),true);assert.equal(f.store.replyStatus('pending').status,'cancelled');assert.equal(f.store.replyStatus('unknown').status,'uncertain');assert.ok(f.store.get('SELECT digest FROM replies WHERE message_id=?','pending'));
});
test('an uncertain control reply stays uncertain after restart and duplicate receipt never resends it',async t=>{
  const f=fixture(t,{send:async()=>{throw Error('unknown send');}});let management=f.create();management.accept(f.message('a','/status'));await management.tick();assert.equal(f.calls.length,1);assert.equal(f.store.get('SELECT state FROM bridge_management_reply').state,'uncertain');management=f.create();management.accept(f.message('a','/status'));await management.tick();assert.equal(f.calls.length,1);
});
test('checkpoint failure rolls back both control admission and cancellation',t=>{
  const f=fixture(t),management=f.create();assert.throws(()=>management.accept(f.message('a','/status'),()=>{throw Error('checkpoint failed');}));assert.equal(f.store.get('SELECT count(*) AS n FROM bridge_management_reply').n,0);
});


test('local queue exposes working and uncertain native feedback instead of cancelling it',async t=>{
 const f=fixture(t),management=f.create(),future=Date.now()+60000;f.store.db.exec('CREATE TABLE feedback(message_id TEXT PRIMARY KEY,state TEXT);');
 f.store.run('INSERT INTO messages VALUES (?,?,?,?,?,?)','busy','owner','sub',1,future,'private input');f.store.run("INSERT INTO feedback VALUES ('busy','working')");
 assert.equal(management.queue()[0].reply_state,'processing');assert.equal(management.accept(f.message('cancel-busy','/cancel')),true);await management.tick();assert.equal(management.cancelled('busy'),false);
 f.store.run("UPDATE feedback SET state='uncertain'");assert.equal(management.queue()[0].reply_state,'uncertain');
});

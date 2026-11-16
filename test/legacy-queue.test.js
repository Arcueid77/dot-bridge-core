import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {LegacyConversationQueue} from '../channels/legacy-conversation-queue.js';

function fixture(t,mode='batch') {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,subscription_id TEXT,generation TEXT,received INTEGER,expires INTEGER,text TEXT,attempted_at INTEGER);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,message_id TEXT,kind TEXT,state TEXT,attempts INTEGER,next_at INTEGER);
    CREATE TABLE replies(message_id TEXT PRIMARY KEY);
    CREATE TABLE dotbridge_tasks(source_id TEXT);`);
  const store={db,get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),
    run:(sql,...args)=>db.prepare(sql).run(...args),vault:{seal:JSON.stringify,open:JSON.parse},
    message:id=>db.prepare('SELECT * FROM messages WHERE id=?').get(id),tx:fn=>{
      db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
    }};
  let now=1000;
  const outcomes=new Map();
  const queue=new LegacyConversationQueue({store,policy:{mode,windowMs:100,maxMessages:5},clock:()=>now,
    key:()=> 'private-context',status:id=>({status:outcomes.get(id)??'none'})});
  const add=(id,generation='one')=>{
    store.run('INSERT INTO messages VALUES (?,?,?,?,?,?,NULL)',id,'original-dot',generation,now,now+900000,id);
    store.run("INSERT INTO jobs VALUES (?,?, 'event','pending',0,?)",'event:'+id,id,now);
  };
  return {store,queue,outcomes,add,advance:ms=>{now+=ms;}};
}

test('legacy batches keep source rows and one encrypted membership payload under the same generation',t=>{
  const f=fixture(t);f.add('first');f.add('second');f.add('separate-generation','two');
  f.queue.prepare();assert.equal(f.store.get("SELECT next_at FROM jobs WHERE id='event:first'").next_at,1100);
  f.advance(101);f.queue.prepare();
  assert.deepEqual(f.queue.members('second'),['first','second']);
  assert.deepEqual(f.queue.members('separate-generation'),['separate-generation']);
  assert.equal(f.queue.text(f.store.message('second')),'[1] first\n\n[2] second');
  assert.equal(f.store.get("SELECT state FROM jobs WHERE id='event:first'").state,'batched');
  assert.throws(()=>f.queue.assertWritable('first'));f.queue.assertWritable('second');
  f.queue.markAttempted(f.store.message('second'),1101);
  assert.equal(f.store.message('first').attempted_at,1101);
  assert.equal(f.store.get('SELECT count(*) AS n FROM messages').n,3);
});

test('legacy serial queues wait for the prior result and preserve an uncertain reply without replay',t=>{
  const f=fixture(t,'serial');f.add('first');f.add('second');
  f.store.run("UPDATE jobs SET state='delivered',attempts=1 WHERE id='event:first'");
  assert.equal(f.queue.canDispatch(f.store.message('second')),false);
  f.outcomes.set('first','uncertain');
  assert.equal(f.queue.canDispatch(f.store.message('second')),true);
  assert.equal(f.outcomes.get('first'),'uncertain');
});

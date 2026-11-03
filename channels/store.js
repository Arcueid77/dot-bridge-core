import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {privateDatabasePath} from '../packages/dot-bridge-platform/private-files.js';
import {sourceIdentity,routeOf} from './experience-policy.js';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export class ChannelStore{
 constructor(config){
  this.key=Buffer.from(config.storageKey,'base64');this.config=config;
  this.lease=privateDatabasePath(config.dbPath,{create:true});
  try{
   this.db=new DatabaseSync(this.lease.path);
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS channel_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_messages(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,event_state TEXT NOT NULL,reply_state TEXT NOT NULL,subscription_id TEXT,reply TEXT,reply_digest TEXT,event_attempts INTEGER NOT NULL DEFAULT 0,event_next_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS channel_pending ON channel_messages(event_state,reply_state,created);`);
   const identityKeys=Object.keys(config.credentials).filter(k=>/Id$/.test(k)).sort();
   const binding={channel:config.channel.id,...Object.fromEntries(identityKeys.map(k=>[k,config.credentials[k]]))};
   const existing=this.get('binding');if(existing&&JSON.stringify(existing)!==JSON.stringify(binding))throw Error('Existing database binding differs');
   if(!existing)this.set('binding',binding);
   this.db.exec("UPDATE channel_messages SET event_state='uncertain' WHERE event_state='processing'; UPDATE channel_messages SET reply_state='uncertain' WHERE reply_state='processing';");
  }catch(error){this.db?.close();this.lease.close();this.key.fill(0);throw error;}
 }
 seal(value,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
 open(value,aad){const data=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));}
 get(key){const row=this.db.prepare('SELECT value FROM channel_metadata WHERE key=?').get(key);return row?this.open(row.value,`meta:${key}`):undefined;}
 set(key,value){const bytes=JSON.stringify(value);if(typeof key!=='string'||key.length>256||bytes.length>131072)throw Error('State limit exceeded');this.db.prepare('INSERT INTO channel_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,this.seal(value,`meta:${key}`));}
 delete(key){this.db.prepare('DELETE FROM channel_metadata WHERE key=?').run(key);}
 tx(fn){const depth=this.transactionDepth??0,name='channel_nested_'+depth;this.db.exec(depth?'SAVEPOINT '+name:'BEGIN IMMEDIATE');this.transactionDepth=depth+1;try{const value=fn();if(value&&typeof value.then==='function')throw Error('Private state transaction must be synchronous');this.db.exec(depth?'RELEASE SAVEPOINT '+name:'COMMIT');return value;}catch(e){this.db.exec(depth?'ROLLBACK TO SAVEPOINT '+name:'ROLLBACK');if(depth)this.db.exec('RELEASE SAVEPOINT '+name);throw e;}finally{this.transactionDepth=depth;}}
 message(id){const row=this.db.prepare('SELECT rowid AS accepted_order,* FROM channel_messages WHERE id=?').get(id);return row?{...row,message:this.open(row.payload,`message:${id}`)}:undefined;}
 insert(message,now,expires,subscription){
  const source=hash(sourceIdentity(this.config.channel.id,message)),id=`msg_${source}`;
  if(this.db.prepare('SELECT 1 FROM channel_messages WHERE source=?').get(source))return false;
  if(this.db.prepare('SELECT count(*) AS n FROM channel_messages WHERE expires>?').get(now).n>=1000)throw Error('Inbox capacity reached');
  this.db.prepare('INSERT INTO channel_messages(id,source,payload,created,expires,event_state,reply_state,subscription_id) VALUES (?,?,?,?,?,?,?,?)').run(id,source,this.seal(message,`message:${id}`),now,expires,'pending','none',subscription?.id??null);return id;
 }
 pending(now){return this.db.prepare("SELECT id,expires,reply_state FROM channel_messages WHERE expires>? AND reply_state IN ('none','pending','processing') ORDER BY created DESC LIMIT 10").all(now).map(r=>({message_id:r.id,reply_deadline:new Date(r.expires).toISOString(),reply_status:r.reply_state}));}
 context(anchor,{limit=20,maxChars=12000}={}){
  const route=routeOf(this.config,anchor.message),result=[];let remaining=maxChars;
  if(!route)return result;
  for(const row of this.db.prepare('SELECT * FROM channel_messages WHERE subscription_id=? AND rowid<? ORDER BY rowid DESC LIMIT 1000').all(anchor.subscription_id,anchor.accepted_order)){
   if(row.id===anchor.id)continue;
   const message=this.open(row.payload,'message:'+row.id),other=routeOf(this.config,message);
   if(message.control||other?.key!==route.key)continue;
   const text=message.text.slice(0,remaining);remaining-=text.length;
   const item={message_id:row.id,text,reply_status:row.reply_state};
   if(row.reply_state==='sent'&&row.reply){const reply=this.open(row.reply,'reply:'+row.id);if(reply.text){item.reply=reply.text.slice(0,remaining);remaining-=item.reply.length;}}
   result.push(item);if(result.length>=limit||remaining<=0)break;
  }
  return result.reverse();
 }
 expire(now){this.db.prepare("UPDATE channel_messages SET reply_state='expired' WHERE expires<=? AND reply_state IN ('none','pending')").run(now);this.db.prepare("UPDATE channel_messages SET event_state='expired' WHERE expires<=? AND event_state='pending'").run(now);}
 purge(now){this.expire(now);this.db.prepare("DELETE FROM channel_messages WHERE created<? AND event_state<>'processing' AND reply_state<>'processing'").run(now-this.config.retentionMs);}
 close(){try{this.db.close();}finally{this.lease.close();this.key.fill(0);}}
}

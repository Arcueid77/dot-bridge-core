import {BridgeError} from '../router/common.js';

// QQ and Lark retain their established messages/jobs schema and leased workers.
export class LegacyConversationQueue {
  constructor({store, policy, key, status, onMerge = () => {}, clock = Date.now, maxText = 2000, ErrorType = BridgeError}) {
    Object.assign(this, {store, policy: policy ?? {mode: 'independent'}, key, status, onMerge, clock, maxText, ErrorType});
    store.db.exec(`CREATE TABLE IF NOT EXISTS dotbridge_batches(anchor_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dotbridge_batch_members(source_id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL);`);
  }
  anchor(id) {return this.store.get('SELECT anchor_id FROM dotbridge_batch_members WHERE source_id=?',id)?.anchor_id ?? id;}
  members(id) {
    const anchor=this.anchor(id), row=this.store.get('SELECT payload FROM dotbridge_batches WHERE anchor_id=?',anchor);
    return row ? this.store.vault.open(row.payload,'batch:'+anchor).members : [id];
  }
  assertWritable(id) {
    const anchor=this.anchor(id);
    if(anchor!==id)throw new this.ErrorType('Use the anchor of this combined reply.',{code:-32013,status:409,data:{reason:'combined_reply',message_id:anchor}});
  }
  text(message) {
    const members=this.members(message.id);
    if(members.length<2||this.anchor(message.id)!==message.id)return message.text;
    return members.map((id,index)=>'['+(index+1)+'] '+this.store.message(id).text).join('\n\n');
  }
  prepare() {
    const {store}=this, now=this.clock();
    store.run('DELETE FROM dotbridge_batch_members WHERE anchor_id NOT IN (SELECT id FROM messages)');
    store.run('DELETE FROM dotbridge_batches WHERE anchor_id NOT IN (SELECT id FROM messages)');
    if(this.policy.mode!=='batch')return;
    const candidates=store.all(`SELECT m.id FROM messages m JOIN jobs j ON j.message_id=m.id
      WHERE j.kind='event' AND j.state='pending' AND j.attempts=0 AND m.expires>?
      AND NOT EXISTS(SELECT 1 FROM replies r WHERE r.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM jobs progress WHERE progress.message_id=m.id AND progress.kind='stream' AND progress.attempts>0)
      AND NOT EXISTS(SELECT 1 FROM dotbridge_tasks t WHERE t.source_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM dotbridge_batch_members b WHERE b.source_id=m.id)
      ORDER BY m.received,m.rowid LIMIT 1000`,now);
    const groups=new Map();
    for(const candidate of candidates){
      const message=store.message(candidate.id), route=this.key(message);
      if(!route||!message.text||message.attachments?.length||message.quote_id||store.quote?.(message))continue;
      const key=JSON.stringify([message.subscription_id,message.generation,route]);
      const rows=groups.get(key)??[];rows.push(message);groups.set(key,rows);
      if(message.received+this.policy.windowMs>now)store.run("UPDATE jobs SET next_at=? WHERE message_id=? AND kind IN ('event','stream') AND state='pending'",message.received+this.policy.windowMs,message.id);
    }
    for(const rows of groups.values()){
      const first=rows[0];if(first.received+this.policy.windowMs>now)continue;
      const selected=[];let length=0;
      for(const row of rows){
        if(selected.length>=this.policy.maxMessages||row.received>first.received+this.policy.windowMs||length+row.text.length+16>this.maxText)break;
        selected.push(row);length+=row.text.length+16;
      }
      if(selected.length<2)continue;
      const anchor=selected.at(-1), members=selected.map(row=>row.id);
      store.tx(()=>{
        for(const row of selected){
          store.run('INSERT INTO dotbridge_batch_members VALUES (?,?)',row.id,anchor.id);
          if(row.id!==anchor.id)store.run("UPDATE jobs SET state='batched' WHERE message_id=? AND kind='event' AND state='pending'",row.id);
          if(row.id!==anchor.id)this.onMerge(row.id);
        }
        store.run('INSERT INTO dotbridge_batches VALUES (?,?)',anchor.id,store.vault.seal({members},'batch:'+anchor.id));
        store.run("UPDATE jobs SET next_at=? WHERE message_id=? AND kind='event' AND state='pending'",now,anchor.id);
      });
    }
  }
  canDispatch(message) {
    if(this.policy.mode==='independent')return true;
    const order=this.store.get('SELECT rowid AS n FROM messages WHERE id=?',message.id).n;
    const prior=this.store.all(`SELECT m.id FROM messages m JOIN jobs j ON j.message_id=m.id
      WHERE m.rowid<? AND m.subscription_id=? AND m.generation=? AND m.expires>?
      AND j.kind='event' AND j.state IN ('pending','processing','delivered','uncertain') ORDER BY m.rowid LIMIT 1000`,
      order,message.subscription_id,message.generation,this.clock());
    return !prior.some(row=>{
      if(this.anchor(row.id)!==row.id)return false;
      return ['none','pending','processing'].includes(this.status(row.id).status)&&this.key(this.store.message(row.id))===this.key(message);
    });
  }
  markAttempted(message,now) {
    for(const id of this.members(message.id))this.store.run('UPDATE messages SET attempted_at=? WHERE id=?',now,id);
  }
}

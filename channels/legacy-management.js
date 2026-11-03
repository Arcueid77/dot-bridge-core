import {createHash} from 'node:crypto';
import {parseManagement,managementText} from './management.js';

// Adapter for the established Lark/QQ stores. Only this local control outbox is
// added; existing inbox, subscription generations and uncertain jobs stay intact.
export class LegacyManagement {
  constructor({store,channel,enabled=false,receiveWithoutSubscription=false,ownerPrivate,status,sendReply,clock=Date.now}) {
    Object.assign(this,{store,channel,enabled,receiveWithoutSubscription,ownerPrivate,status,sendReply,clock});this.busy=false;
    store.db.exec("CREATE TABLE IF NOT EXISTS bridge_management_reply(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bridge_management_cancelled(message_id TEXT PRIMARY KEY); UPDATE bridge_management_reply SET state='uncertain' WHERE state='processing';");
  }
  queue() {
    return this.store.all('SELECT id FROM messages WHERE expires>? AND text IS NOT NULL ORDER BY received DESC,rowid DESC LIMIT 1000',this.clock()).map(row=>this.store.message(row.id)).filter(message=>this.ownerPrivate(message)).map(message=>{
      const states=this.store.all("SELECT state FROM jobs WHERE message_id=? AND state IN ('pending','processing','uncertain')",message.id);
      for(const table of ['feedback','reply_streams'])if(this.store.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)){
        const row=this.store.get('SELECT state FROM '+table+' WHERE message_id=?',message.id);if(row&&['working','processing','uncertain'].includes(row.state))states.push({state:row.state==='working'?'processing':row.state});
      }
      const status=this.store.replyStatus(message.id).status;
      return {id:message.id,reply_state:states.some(row=>row.state==='uncertain')?'uncertain':states.some(row=>row.state==='processing')?'processing':this.cancelled(message.id)?'cancelled':status==='none'?'none':status};
    }).filter(row=>['none','pending','processing','uncertain'].includes(row.reply_state));
  }
  cancelled(id) {return !!this.store.get('SELECT message_id FROM bridge_management_cancelled WHERE message_id=?',id);}
  cancel(row) {
    const message=this.store.message(row.id);
    if(!message||!this.ownerPrivate(message)||this.store.get("SELECT id FROM jobs WHERE message_id=? AND kind<>'event' AND state IN ('processing','uncertain')",row.id))throw Error('Control cancellation requires settled delivery state');
    if(this.store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")&&this.store.get("SELECT message_id FROM feedback WHERE message_id=? AND state IN ('working','uncertain')",row.id))throw Error('Feedback outcome requires review');
    this.store.run('INSERT OR IGNORE INTO bridge_management_cancelled VALUES (?)',row.id);
    const digest=createHash('sha256').update('owner-cancelled:'+row.id).digest('hex');
    this.store.run('INSERT OR IGNORE INTO replies(message_id,digest,text,created) VALUES (?,?,NULL,?)',row.id,digest,this.clock());
    this.store.run("INSERT OR IGNORE INTO jobs(id,kind,message_id,subscription_id,state,next_at) VALUES (?,'reply',?,?,'cancelled',?)",'reply:'+row.id,row.id,message.subscription_id,this.clock());
    this.store.run("UPDATE jobs SET state='cancelled',last_error='owner_cancelled',lease_token=NULL,lease_until=NULL WHERE message_id=? AND state='pending'",row.id);
  }
  accept(message,checkpoint) {
    const command=this.enabled&&this.ownerPrivate(message)&&!message.forwarded&&(parseManagement(message.text)||(this.receiveWithoutSubscription&&!this.status().subscription_active?{name:'subscription'}:undefined));
    if(!command)return false;
    return this.store.tx(()=>{
      if(checkpoint)checkpoint();
      if(this.store.get('SELECT id FROM bridge_management_reply WHERE id=?',message.id))return true;
      if(this.store.get("SELECT count(*) AS n FROM bridge_management_reply WHERE state IN ('pending','processing')").n>=200)throw Error('Local control queue is full');
      const text=managementText({command,state:this.status(),queue:this.queue(),channelName:this.channel,cancel:row=>this.cancel(row)});
      const payload=this.store.vault.seal({message,text},'management:'+message.id);
      this.store.run("INSERT INTO bridge_management_reply VALUES (?,?,?,?,'pending')",message.id,payload,this.clock(),Math.min(message.expires,this.clock()+900000));
      return true;
    });
  }
  async tick() {
    if(!this.enabled||this.busy)return false;this.busy=true;
    try{
      this.store.run("UPDATE bridge_management_reply SET state='expired' WHERE state='pending' AND expires<=?",this.clock());
      this.store.run("DELETE FROM bridge_management_reply WHERE created<? AND state NOT IN ('pending','processing','uncertain')",this.clock()-604800000);
      const row=this.store.get("SELECT * FROM bridge_management_reply WHERE state='pending' AND expires>? ORDER BY created,id LIMIT 1",this.clock());if(!row)return false;
      const value=this.store.vault.open(row.payload,'management:'+row.id);
      const authorize=()=>{if(!this.enabled||!this.ownerPrivate(value.message)||row.expires<=this.clock()||this.store.get('SELECT state FROM bridge_management_reply WHERE id=?',row.id)?.state!=='processing')throw Error('Local control authorization changed');};
      this.store.run("UPDATE bridge_management_reply SET state='processing' WHERE id=? AND state='pending'",row.id);
      try{authorize();await this.sendReply(value.message,value.text,authorize);this.store.run("UPDATE bridge_management_reply SET state='sent' WHERE id=?",row.id);}
      catch{this.store.run("UPDATE bridge_management_reply SET state='uncertain' WHERE id=?",row.id);}
      return true;
    }finally{this.busy=false;}
  }
}

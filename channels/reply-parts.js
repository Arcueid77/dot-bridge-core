export class ReplyParts {
  constructor(service) {
    this.service=service;this.store=service.store;
    this.store.db.exec("CREATE TABLE IF NOT EXISTS channel_reply_parts(message_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(message_id,ordinal)); UPDATE channel_reply_parts SET state='uncertain' WHERE state='processing';");
  }
  prepare(row,reply) {
    if(reply.media||this.service.experience.policy.replies.longText!=='chunks'||typeof this.service.provider.planTextReply!=='function')return;
    const parts=this.service.provider.planTextReply(reply.text);
    if(!Array.isArray(parts)||!parts.length||parts.length>50)throw Error('Invalid bounded reply plan');
    if(parts.length===1)return;
    if(typeof this.service.provider.sendTextPart!=='function')throw Error('Native text parts unavailable');
    for(const [ordinal,part] of parts.entries()){
      if(!part||typeof part.text!=='string'||!part.text||!part.text.isWellFormed()||part.text.length>100000||!['text','html'].includes(part.format))throw Error('Invalid bounded text part');
      this.store.db.prepare("INSERT INTO channel_reply_parts VALUES (?,?,?,'pending')").run(row.id,ordinal,this.store.seal(part,'reply-part:'+row.id+':'+ordinal));
    }
  }
  cleanup() { this.store.db.prepare('DELETE FROM channel_reply_parts WHERE message_id NOT IN (SELECT id FROM channel_messages)').run(); }
  async send(row,reply,authorize) {
    const parts=this.store.db.prepare('SELECT * FROM channel_reply_parts WHERE message_id=? ORDER BY ordinal').all(row.id);
    if(!parts.length)return false;
    for(const part of parts){
      if(part.state==='sent')continue;
      if(part.state!=='pending')throw Error('Uncertain reply part preserved');
      const value=this.store.open(part.payload,'reply-part:'+row.id+':'+part.ordinal);
      authorize();this.store.db.prepare("UPDATE channel_reply_parts SET state='processing' WHERE message_id=? AND ordinal=? AND state='pending'").run(row.id,part.ordinal);
      try{
        const key=reply.idempotencyKey+':part:'+part.ordinal;
        const edited=part.ordinal===0&&await this.service.experience.sendFinal(row,{...reply,text:value.text,format:value.format,idempotencyKey:key},authorize);
        if(!edited)await this.service.provider.sendTextPart({message:row.message,...value,idempotencyKey:key,ordinal:part.ordinal,authorize});
        this.store.db.prepare("UPDATE channel_reply_parts SET state='sent' WHERE message_id=? AND ordinal=?").run(row.id,part.ordinal);
      }catch{
        this.store.db.prepare("UPDATE channel_reply_parts SET state='uncertain' WHERE message_id=? AND ordinal=?").run(row.id,part.ordinal);throw Error('Native reply part outcome is uncertain');
      }
    }
    return true;
  }
}

import {BridgeError} from '../router/common.js';
import {hash} from './store.js';
import {interactionPolicy} from './experience-policy.js';

export class ChannelExperience {
  constructor(service) {
    this.service=service;this.store=service.store;this.policy=service.config.interaction??interactionPolicy({},service.config.channel);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS channel_experience(message_id TEXT PRIMARY KEY,payload TEXT NOT NULL,inflight INTEGER NOT NULL DEFAULT 0);');
    this.store.tx(()=>{
      for(const row of this.store.db.prepare('SELECT message_id,payload,inflight FROM channel_experience').iterate()){
        const value=this.store.open(row.payload,'experience:'+row.message_id);
        if(row.inflight===1)this.save(row.message_id,{...value,streamState:'uncertain'},false);
        else this.saveWork(row.message_id,value);
      }
    });
  }
  get(id) {
    const row=this.store.db.prepare('SELECT payload FROM channel_experience WHERE message_id=?').get(id);
    return row?this.store.open(row.payload,'experience:'+id):{phase:'received',sequence:0,text:'',lease:0,typingAt:0,feedbackApplied:false,streamState:'none'};
  }
  save(id,value,inflight) {
    this.store.tx(()=>{
      const busy=inflight===undefined?(this.store.db.prepare('SELECT inflight FROM channel_experience WHERE message_id=?').get(id)?.inflight??0):(inflight?1:0);
      this.store.db.prepare('INSERT INTO channel_experience VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET payload=excluded.payload,inflight=excluded.inflight').run(id,this.store.seal(value,'experience:'+id),busy);
      this.saveWork(id,value);
    });
  }
  saveWork(id,value) {
    const provider=this.service.provider;
    const reaction=typeof provider.setFeedback==='function'&&value.feedbackApplied&&(value.feedbackFailures??0)<3;
    const typing=typeof provider.setTyping==='function'&&value.typingActive&&(value.typingFailures??0)<3;
    const uncertain=value.streamState==='uncertain';
    const stream=typeof provider.finishProgress==='function'&&value.streamReference&&value.phase!=='finished'&&!uncertain&&(value.cleanupFailures??0)<3;
    this.store.db.prepare(`INSERT INTO channel_experience_work(message_id,cleanup,uncertain) VALUES (?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET cleanup=excluded.cleanup,uncertain=excluded.uncertain`)
      .run(id,Number(Boolean(reaction||typing||stream)),Number(uncertain));
  }
  accepted(row) { if(this.policy.feedback.enabled&&!row.message.control)this.save(row.id,this.get(row.id)); }
  status(row) { const value=this.get(row.id);return {message_id:row.id,status:value.streamState==='uncertain'?'uncertain':row.reply_state==='none'&&value.phase==='processing'&&value.lease>this.service.clock()?'processing':row.reply_state}; }
  begin(row) {
    this.service.authorized(row);const value=this.get(row.id);
    if(row.reply_state!=='none'||value.phase==='cancelled'||value.streamState==='uncertain')return this.status(row);
    this.save(row.id,{...value,phase:'processing',lease:this.service.clock()+this.policy.feedback.leaseMs});this.service.wake();return this.status(this.store.message(row.id));
  }
  append(row,{sequence,text}) {
    this.service.authorized(row);const value=this.get(row.id);
    if(!this.service.config.channel.experience?.streaming||typeof this.service.provider.sendProgress!=='function'||!this.policy.feedback.enabled||!this.policy.feedback.streaming)throw new BridgeError('Progressive replies are not enabled');
    if(value.streamState==='uncertain')return this.status(row);
    const digest=hash(text);
    if(sequence===value.sequence){if(digest!==value.digest)throw new BridgeError('Progress sequence conflict',{status:409,code:-32013});return this.status(row);}
    if(row.reply_state!=='none'||value.phase!=='processing'||sequence!==value.sequence+1||!text.startsWith(value.text))throw new BridgeError('Progress must extend the previous generated text in order',{status:409,code:-32013});
    this.save(row.id,{...value,sequence,text,digest,lease:this.service.clock()+this.policy.feedback.leaseMs});this.service.wake();return this.status(row);
  }
  cancel(row) {
    if(this.get(row.id).streamState==='uncertain')return {message_id:row.id,status:'uncertain'};
    if(this.store.db.prepare('SELECT inflight FROM channel_experience WHERE message_id=?').get(row.id)?.inflight)return {message_id:row.id,status:'processing'};
    if(!['none','pending'].includes(row.reply_state))return {message_id:row.id,status:row.reply_state};
    this.store.db.prepare("UPDATE channel_messages SET reply_state='cancelled',event_state=CASE WHEN event_state='pending' THEN 'cancelled' ELSE event_state END WHERE id=? AND reply_state IN ('none','pending')").run(row.id);
    const value=this.get(row.id);this.save(row.id,{...value,phase:'cancelled',lease:0});this.service.wake();return {message_id:row.id,status:this.store.message(row.id).reply_state};
  }
  async tick() {
    const {service,store,policy}=this;
    store.db.prepare('DELETE FROM channel_experience WHERE message_id NOT IN (SELECT id FROM channel_messages)').run();
    store.db.prepare('DELETE FROM channel_experience_work WHERE message_id NOT IN (SELECT message_id FROM channel_experience)').run();
    const subscription=service.subscription(), subscriptionId=subscription?subscription.id+':'+subscription.generation:null;
    const candidates=store.db.prepare(`WITH work AS (
      SELECT e.message_id,e.rowid AS ordinal,w.cleanup,
        m.subscription_id=? AND m.expires>? AND m.reply_state IN ('none','pending','processing')
        AND m.event_state IN ('pending','processing','delivered','uncertain') AS active
      FROM channel_experience e JOIN channel_messages m ON m.id=e.message_id
      JOIN channel_experience_work w ON w.message_id=e.message_id)
      SELECT message_id FROM work WHERE active OR cleanup=1 ORDER BY active DESC,ordinal LIMIT 1004`)
      .all(subscriptionId,service.clock());
    let budget=4;
    for(const item of candidates){
      const row=store.message(item.message_id);if(!row||row.message.control)continue;
      let value=this.get(row.id);
      const active=service.subscription();
      const terminal=['sent','cancelled','expired','uncertain'].includes(row.reply_state)||['batched','cancelled','expired'].includes(row.event_state)||
        row.event_state==='uncertain'&&value.phase!=='processing'||row.expires<=service.clock()||!active||row.subscription_id!==active.id+':'+active.generation;
      const authorize=()=>{if(service.closed)throw new Error('Stopping');if(!terminal)service.authorized(store.message(row.id));};
      if(typeof service.provider.setFeedback==='function'&&(policy.feedback.enabled||value.feedbackApplied)){
        const active=!terminal&&policy.feedback.enabled&&policy.feedback.reaction;
        if(value.feedbackApplied!==active&&(value.feedbackNextAt??0)<=service.clock()&&(value.feedbackFailures??0)<3){if(--budget<0)return;try{const reference=await service.provider.setFeedback({message:row.message,active,reference:value.feedbackReference,authorize});value={...this.get(row.id),feedbackApplied:active,feedbackReference:reference??null,feedbackFailures:0};this.save(row.id,value);}catch{value={...this.get(row.id),feedbackFailures:(value.feedbackFailures??0)+1,feedbackNextAt:service.clock()+30000};this.save(row.id,value);}}
      }
      const typing=policy.feedback.enabled&&policy.feedback.typing&&!terminal&&value.phase==='processing'&&value.lease>service.clock();
      if(typeof service.provider.setTyping==='function'&&(value.typingFailures??0)<3&&(typing&&service.clock()-value.typingAt>=4000||!typing&&value.typingActive)){
        if(--budget<0)return;
        try{await service.provider.setTyping({message:row.message,active:typing,authorize});value={...this.get(row.id),typingAt:service.clock(),typingActive:typing,typingFailures:0};this.save(row.id,value);}catch{value={...this.get(row.id),typingAt:service.clock(),typingFailures:(value.typingFailures??0)+1};this.save(row.id,value);}
      }
      if (!terminal && policy.feedback.enabled && policy.feedback.typing && value.phase === 'processing' &&
          value.lease > service.clock() && !value.streamReference && value.streamState === 'none' &&
          typeof service.provider.beginProgress === 'function') {
        if (--budget < 0) return;
        try {
          service.authorized(row);
          this.save(row.id, value, true);
          const reference = await service.provider.beginProgress({message: row.message, authorize});
          if (!reference || JSON.stringify(reference).length > 65536) throw new Error('Processing receipt is unavailable.');
          value = {...this.get(row.id), streamReference: reference, streamState: 'active', appliedSequence: 0, appliedChars: 0};
          this.save(row.id, value, false);
        } catch { value = {...this.get(row.id), streamState: 'uncertain'}; this.save(row.id, value, false); }
      }
      if(!terminal&&value.sequence>(value.appliedSequence??0)&&value.streamState!=='uncertain'&&typeof service.provider.sendProgress==='function'){
        const elapsed=service.clock()-(value.progressAt??0);
        const growth=value.text.length-(value.appliedChars??0);
        if(value.appliedSequence>0&&(elapsed<policy.feedback.updateIntervalMs||growth<policy.feedback.minUpdateChars&&elapsed<policy.feedback.updateIntervalMs*2))continue;
        if(--budget<0)return;
        try{
          service.authorized(row);this.save(row.id,value,true);
          const reference=await service.provider.sendProgress({message:row.message,text:value.text,reference:value.streamReference,idempotencyKey:'progress:'+row.id,authorize});
          value={...this.get(row.id),streamReference:reference,streamState:'active',appliedSequence:value.sequence,progressAt:service.clock(),appliedChars:value.text.length};this.save(row.id,value,false);
        }catch{this.save(row.id,{...this.get(row.id),streamState:'uncertain'},false);}
      }
      if(terminal&&value.streamReference&&value.phase!=='finished'&&value.streamState!=='uncertain'&&row.reply_state!=='uncertain'&&row.event_state!=='uncertain'&&(value.cleanupFailures??0)<3&&(value.cleanupNextAt??0)<=service.clock()&&typeof service.provider.finishProgress==='function'){
        if(--budget<0)return;
        try{await service.provider.finishProgress({message:row.message,reference:value.streamReference,cancelled:row.reply_state!=='sent',authorize});this.save(row.id,{...this.get(row.id),phase:'finished',cleanupFailures:0});}catch{this.save(row.id,{...this.get(row.id),cleanupFailures:(value.cleanupFailures??0)+1,cleanupNextAt:service.clock()+30000});}
      }
    }
  }
  async sendFinal(row,reply,authorize) {
    const value=this.get(row.id);
    if(value.streamState==='uncertain')throw new Error('Uncertain progress is preserved');
    if(reply.choices&&typeof this.service.provider.sendChoiceReply==='function'){
      this.save(row.id,value,true);
      try{
        const receipt=await this.service.provider.sendChoiceReply({message:row.message,text:reply.prompt,choices:reply.choices,presentation:reply.presentation,reference:value.streamReference,idempotencyKey:reply.idempotencyKey,authorize});
        this.service.choices.bindPrompt(row.id,receipt?.id);
        this.save(row.id,{...value,phase:'finished',streamState:'final',lease:0},false);
        return true;
      }catch{this.save(row.id,{...value,streamState:'uncertain'},false);throw new Error('Choice reply acknowledgement is uncertain');}
    }
    if(value.streamReference){
      if(reply.media||this.service.provider.canProgressFinal?.({text:reply.text,format:reply.format})===false){
        if(typeof this.service.provider.finishProgress!=='function')throw new Error('Progress cannot be replaced safely');
        this.save(row.id,value,true);
        try{await this.service.provider.finishProgress({message:row.message,reference:value.streamReference,cancelled:true,replacement:true,authorize});this.save(row.id,{...value,phase:'finished',streamReference:null},false);return false;}
        catch{this.save(row.id,{...value,streamState:'uncertain'},false);throw new Error('Progress replacement outcome is uncertain');}
      }
      this.save(row.id,value,true);
      try{await this.service.provider.sendProgress({message:row.message,text:reply.text,format:reply.format,reference:value.streamReference,final:true,idempotencyKey:reply.idempotencyKey,authorize});this.save(row.id,{...value,phase:'finished',streamState:'final',lease:0},false);return true;}
      catch{this.save(row.id,{...value,streamState:'uncertain'},false);throw new Error('Progress final acknowledgement is uncertain');}
    }
    return false;
  }
}

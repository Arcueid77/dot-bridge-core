import {routeOf} from './experience-policy.js';
import {createHash} from 'node:crypto';

const commands=new Set(['help','status','queue','subscription','cancel','stop','new','reset','approve']);
const reference=row=>row.id.startsWith('msg_')?row.id.slice(4,16):createHash('sha256').update(row.id).digest('hex').slice(0,12);
export function parseManagement(text) {
  if(typeof text!=='string')return;
  const match=/^\/(help|status|queue|subscription|cancel|stop|new|reset|approve)(?:\s+([A-Za-z0-9_-]{1,256}))?\s*$/.exec(text);
  return match&&commands.has(match[1])?{name:match[1],argument:match[2]}:undefined;
}

export class ChannelManagement {
  constructor(service) {
    this.service=service;this.store=service.store;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS channel_management(message_id TEXT PRIMARY KEY);');
  }
  command(message) {
    if(!this.service.config.channel.experience||!this.service.experience.policy.management.enabled||message.forwarded||routeOf(this.service.config,message)?.scope!=='owner')return;
    return parseManagement(message.text);
  }
  mark(id) {
    this.store.db.prepare('INSERT OR IGNORE INTO channel_management VALUES (?)').run(id);
    this.store.db.prepare("UPDATE channel_messages SET event_state='cancelled' WHERE id=?").run(id);
  }
  marked(id) { return !!this.store.db.prepare('SELECT message_id FROM channel_management WHERE message_id=?').get(id); }
  queue(anchor) {
    const key=routeOf(this.service.config,anchor.message)?.key,result=[];
    for(const row of this.store.db.prepare("SELECT id FROM channel_messages WHERE reply_state IN ('none','pending','processing','uncertain') AND expires>? ORDER BY rowid DESC LIMIT 1000").all(this.service.clock())){
      if(this.marked(row.id))continue;
      const value=this.store.message(row.id);
      if(this.service.experience.get(row.id).streamState==='uncertain'||value.event_state==='uncertain')value.reply_state='uncertain';
      if(routeOf(this.service.config,value.message)?.key===key)result.push(value);
    }
    return result;
  }
  respond(anchor,command) {return managementText({command,state:this.service.setup(),queue:this.queue(anchor),channelName:this.service.config.channel.name,cancel:row=>this.service.experience.cancel(row)});}

  handle(row,command) {
    this.mark(row.id);
    const text=this.respond(row,command);
    this.service.queueFinalReply(this.store.message(row.id),{text,idempotencyKey:'management:'+row.id},'management:'+row.id,false);
  }
}

export function managementText({command,state,queue,channelName,cancel}) {
    if(command.name==='help')return [
      '/status — 连接、队列与订阅状态 / connection and queue status',
      '/queue — 当前会话待回复列表 / pending replies in this conversation',
      '/subscription — 订阅到期时间 / subscription expiry',
      '/cancel [编号] — 取消尚未发送的回复；省略编号取消最近一条 / cancel an unsent reply',
      '处理已在发送中或结果不明时不会自动重发。Inflight and uncertain deliveries are preserved.',
      '/stop、/new、/reset、/approve 的原 dot 控制请在原平台操作。Hosted-dot controls stay on the original platform.',
    ].join('\n');
    if(command.name==='status')return [
      channelName,
      '绑定 / binding: '+(state.binding_ready===true?'ready':state.binding_ready===false?'unavailable':'unknown'),
      '网关 / gateway: '+(state.gateway_connected===true?'connected':state.gateway_connected===false?'disconnected':'unknown'),
      '订阅 / subscription: '+state.subscription_status.state,
      '待回复 / pending: '+queue.filter(row=>['none','pending'].includes(row.reply_state)).length,
      '发送中 / sending: '+queue.filter(row=>row.reply_state==='processing').length,
      '结果不明 / uncertain: '+queue.filter(row=>row.reply_state==='uncertain').length,
    ].join('\n');
    if(command.name==='subscription')return '订阅 / subscription: '+state.subscription_status.state+'\n到期 / expires (UTC): '+(state.subscription_status.expires_at??'—')+'\n续订方 / renewal owner: original dot platform';
    if(command.name==='queue')return queue.length?queue.slice(0,10).map(row=>reference(row)+' — '+row.reply_state).join('\n'):'当前会话没有待回复消息。No pending replies in this conversation.';
    if(command.name==='cancel'){
      const matches=command.argument?queue.filter(row=>row.id===command.argument||reference(row)===command.argument):queue.filter(row=>['none','pending'].includes(row.reply_state)).slice(0,1);
      if(matches.length!==1)return '没有唯一匹配的待回复消息，请先用 /queue 查看。No unique pending reply matched; use /queue.';
      const row=matches[0];
      if(!['none','pending'].includes(row.reply_state))return '该回复正在发送或结果不明，状态已保留。The reply is inflight or uncertain and has been preserved.';
      cancel(row);
      return '已取消该条桥接回复；原 dot 的执行任务由原平台控制。Bridge reply cancelled; the original platform controls the dot task.';
    }
    return '原 dot 的暂停、会话重置和审批请在原平台操作。/cancel 可取消本桥尚未发送的回复。Use the original platform for hosted-dot pause, reset and approvals; /cancel only cancels an unsent bridge reply.\nhttps://learn.chatgpt.com/docs/dots/controls';
}

import {createHash} from 'node:crypto';
import {object} from '../router/common.js';
import {boundedString} from '../router/live-contract.js';

const fail = () => { throw new Error('Invalid protected interaction policy'); };
const id = value => boundedString(value,256);
const boolean = (value,fallback) => value === undefined ? fallback : typeof value === 'boolean' ? value : fail();
const choice = (value,allowed,fallback) => value === undefined ? fallback : allowed.includes(value) ? value : fail();
const integer = (value,min,max,fallback) => value === undefined ? fallback : Number.isSafeInteger(value)&&value>=min&&value<=max ? value : fail();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function list(value,max) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>max||new Set(value).size!==value.length)fail();
  return value.map(item=>id(item));
}

export function interactionPolicy(input = {}, channel = {}) {
  object(input,['version','feedback','context','replies','management','groups']);
  if(input.version!==undefined&&input.version!==1)fail();
  const feedback=input.feedback??{},context=input.context??{},replies=input.replies??{},management=input.management??{};
  object(feedback,['enabled','reaction','typing','streaming','lease_seconds']);
  object(context,['max_messages','max_chars']);
  object(replies,['long_text']);object(management,['enabled']);
  const groups=input.groups??[];
  if(!Array.isArray(groups)||groups.length>50||(!channel.experience?.groups&&groups.length))fail();
  const seen=new Set();
  const rules=groups.map(group=>{
    object(group,['conversation_id','enabled','members','allow_from','mention','auto_reply','keywords','reply_in_thread','context_scope'],['conversation_id','members']);
    id(group.conversation_id);if(seen.has(group.conversation_id))fail();seen.add(group.conversation_id);
    const members=choice(group.members,['owner','allowlist','all'],'owner'),allowFrom=list(group.allow_from,100),keywords=list(group.keywords,50);
    const autoReply=choice(group.auto_reply,['off','keywords','all'],'off');
    if((members==='allowlist')!==!!allowFrom.length||(autoReply==='keywords')!==!!keywords.length||keywords.some(word=>!word.trim()))fail();
    return Object.freeze({conversationId:group.conversation_id,enabled:boolean(group.enabled,true),members,allowFrom:Object.freeze(allowFrom),mention:boolean(group.mention,true),autoReply,keywords:Object.freeze(keywords),replyInThread:boolean(group.reply_in_thread,true),contextScope:choice(group.context_scope,['sender','group'],'sender')});
  });
  return Object.freeze({
    feedback:Object.freeze({enabled:boolean(feedback.enabled,false),reaction:boolean(feedback.reaction,true),typing:boolean(feedback.typing,true),streaming:boolean(feedback.streaming,true),leaseMs:integer(feedback.lease_seconds,10,300,60)*1000}),
    context:Object.freeze({maxMessages:integer(context.max_messages,1,50,20),maxChars:integer(context.max_chars,1000,20000,12000)}),
    replies:Object.freeze({longText:choice(replies.long_text,['file','chunks'],'file')}),
    management:Object.freeze({enabled:boolean(management.enabled,!!channel.experience)}),groups:Object.freeze(rules),
  });
}

export function conversationRoute(config,message) {
  const policy=config.interaction??interactionPolicy({},config.channel);
  const privateOwner=message.senderId===config.credentials.ownerId&&message.conversationId===config.credentials.conversationId&&message.chatType!=='group';
  if(privateOwner)return {scope:'owner',key:digest([config.channel.id,'owner',message.conversationId,message.threadId??null]),contextScope:'sender',replyInThread:true};
  if(message.chatType!=='group'||!config.channel.experience?.groups)return;
  const group=policy.groups.find(rule=>rule.enabled&&rule.conversationId===message.conversationId);
  if(!group||!(group.members==='all'||group.members==='owner'&&message.senderId===config.credentials.ownerId||group.members==='allowlist'&&group.allowFrom.includes(message.senderId)))return;
  const triggered=group.mention&&message.botMentioned===true||group.autoReply==='all'||group.autoReply==='keywords'&&group.keywords.some(word=>(message.text??'').toLocaleLowerCase().includes(word.toLocaleLowerCase()));
  if(!triggered)return;
  if(message.threadId!==undefined)id(message.threadId);
  return {scope:'configured',key:digest([config.channel.id,'group',message.conversationId,message.threadId??null,group.contextScope==='sender'?message.senderId:null]),contextScope:group.contextScope,replyInThread:group.replyInThread};
}

export function routeOf(config,message) {
  return message.route??conversationRoute(config,{...message,chatType:message.chatType??'private'});
}

export function sourceIdentity(channel,message) {
  return message.route?.scope==='configured' ? JSON.stringify([channel,message.conversationId,message.threadId??null,message.id]) : channel+':'+message.id;
}

export function cleanQuote(value) {
  if(value===undefined)return;
  object(value,['text','messageId','truncated']);
  if(value.messageId!==undefined)id(value.messageId);
  if(value.text!==undefined&&typeof value.text!=='string'||value.truncated!==undefined&&typeof value.truncated!=='boolean')fail();
  const text=value.text===undefined?undefined:value.text.toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'\ufffd');
  if(text!==undefined)boundedString(text,4000,{empty:true,multiline:true});
  return {...value,...(text===undefined?{}:{text})};
}

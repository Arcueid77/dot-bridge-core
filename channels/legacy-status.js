// Read adapter for the established Lark/QQ SQLite layout. Provider repositories
// keep their existing store/encryption classes; this code never migrates them.
import {subscriptionDiagnostics,subscriptionStatus,connectionStatus,projectRuntimeStatus} from './status.js';
import {MAX_MEDIA_BYTES,MEDIA_RPC_LIMIT,TUNNEL_ENVELOPE_BYTES} from './tunnel-budget.js';

const DIAGNOSTIC_KEY='status_subscription_diagnostics_v1';
const DIAGNOSTIC_AAD='metadata:subscription-diagnostics:v1';
const FEEDBACK_TERMINAL=new Set(['sent','dead','expired','uncertain','cancelled']);
function activeFeedbackNeedsMutation(store,row,now,hasActiveSubscription) {
  const message=store.get('SELECT expires FROM messages WHERE id=?',row.message_id);
  if(!message)return false;
  const reply=store.get("SELECT state FROM jobs WHERE id=? AND kind='reply'",`reply:${row.message_id}`);
  const notice=!reply?store.get("SELECT state FROM jobs WHERE id=? AND kind='notice'",`notice:${row.message_id}`):undefined;
  const stream=store.get('SELECT state,payload FROM reply_streams WHERE message_id=?',row.message_id);
  const streamTerminal={uncertain:'uncertain',failed:'dead',cancelled:'cancelled',expired:'expired'};
  const replyState=reply?.state??notice?.state??streamTerminal[stream?.state]??'none';
  const event=store.get("SELECT state FROM jobs WHERE kind='event' AND message_id=?",row.message_id)?.state;
  const interaction=store.config?.interaction;
  const terminal=FEEDBACK_TERMINAL.has(replyState)||['dead','uncertain','cancelled','expired'].includes(event)||message.expires<=now||!hasActiveSubscription||!interaction?.enabled;
  if(typeof row.payload!=='string'||row.payload.length>65536)throw Error('Unavailable feedback metadata');
  const data=store.vault.open(row.payload,`feedback:${row.message_id}`);
  if(!data||typeof data.uncertain!=='boolean'||!(data.reactionId===null||typeof data.reactionId==='string'))throw Error('Unavailable feedback metadata');
  if(data.uncertain)throw Error('Uncertain feedback operation');
  const remove=terminal||!interaction?.reactions;
  if(remove?!!data.reactionId:!data.reactionId&&interaction?.reactions)return true;
  if(terminal&&stream&&stream.state!=='complete'){
    if(typeof stream.payload!=='string'||stream.payload.length>524288)throw Error('Unavailable card metadata');
    const card=store.vault.open(stream.payload,`stream:${row.message_id}`);
    if(!card||!(card.cardId===null||typeof card.cardId==='string')||!(card.outboundId===null||typeof card.outboundId==='string'))throw Error('Unavailable card metadata');
    return !!(card.cardId&&card.outboundId);
  }
  return false;
}
export function legacySubscriptionDiagnostics(store) {
  return {
    load(){
      const row=store.get('SELECT value FROM metadata WHERE key=?',DIAGNOSTIC_KEY);
      if(!row)return [];
      try{return subscriptionDiagnostics(store.vault.open(row.value,DIAGNOSTIC_AAD));}catch{return [];}
    },
    save(value){
      const sealed=store.vault.seal(subscriptionDiagnostics(value),DIAGNOSTIC_AAD);
      store.run('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',DIAGNOSTIC_KEY,sealed);
    }
  };
}

export function inspectLegacyRuntimeStatus(store,{principal,now,callbackHosts,bindingReady,gatewayConnected,callbackAllowed,wrongSettingPresent,readBytes=MAX_MEDIA_BYTES,replyBytes=MAX_MEDIA_BYTES}) {
  // Prefer the currently active subscription. If none exists, describe the
  // most recently verified retained record, without inventing a new expiry.
  const row=store.get('SELECT id,active,expires FROM subscriptions WHERE principal=? ORDER BY CASE WHEN active=1 AND expires>? THEN 0 ELSE 1 END,verified_until DESC,expires DESC,id LIMIT 1',principal,now);
  const record=row?{active:row.active===1?true:row.active===0?false:undefined,expires:row.expires}:undefined;
  const diagnostics=legacySubscriptionDiagnostics(store).load(),subscription=subscriptionStatus(record,now,diagnostics);
  let allowed=false;
  if(row)try{allowed=callbackAllowed(store.subscription(row.id))===true;}catch{/* Invalid retained callback is not authorized. */}
  const replyWork={pending:0,processing:0,uncertain:0};
  // Include all queued outbound mutations: final replies, stream frames and
  // feedback jobs. Event callbacks are a separate delivery queue.
  for(const item of store.all("SELECT state,count(*) AS n FROM jobs WHERE kind<>'event' AND state IN ('pending','processing','uncertain') GROUP BY state"))replyWork[item.state]=item.n;
  if(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_management_reply'"))for(const item of store.all("SELECT state,count(*) AS n FROM bridge_management_reply WHERE state IN ('pending','processing','uncertain') GROUP BY state"))replyWork[item.state]+=item.n;
  // A displayed active indicator is not queued work. Count it only when the
  // protected flags and source state require a new mutation or terminal cleanup.
  // No message body or private flag value is returned in this snapshot.
  if(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")){
    for(const item of store.all("SELECT message_id,payload,state,lease_until FROM feedback WHERE state IN ('pending','active','working','uncertain')")){
      if(item.state==='pending')replyWork.pending++;
      else if(item.state==='uncertain')replyWork.uncertain++;
      else if(item.state==='working')replyWork[Number.isSafeInteger(item.lease_until)&&item.lease_until>now?'processing':'uncertain']++;
      else try{if(activeFeedbackNeedsMutation(store,item,now,subscription.state==='active'))replyWork.pending++;}catch{replyWork.uncertain++;}
    }
  }
  const result={subscription_active:subscription.state==='active'&&allowed,subscription_status:subscription,subscription_diagnostics:diagnostics,reply_work:replyWork,
    media_limits:{read_bytes:readBytes,reply_bytes:replyBytes,mcp_body_bytes:MEDIA_RPC_LIMIT,tunnel_envelope_bytes:TUNNEL_ENVELOPE_BYTES}};
  if(typeof bindingReady==='boolean')result.binding_ready=bindingReady;
  if(typeof gatewayConnected==='boolean'){
    result.gateway_connected=gatewayConnected;
    // Legacy scoped experimental transports have their own policy observation;
    // do not mislabel an active scoped grant as a global allowlist entry.
    if(callbackHosts.length||!allowed||subscription.state!=='active')result.connection_status=connectionStatus({gatewayConnected,callbackHosts,subscription,diagnostics,callbackAllowed:allowed,settingName:'MCP_CALLBACK_ALLOWED_HOSTS',wrongSettingPresent,gatewayRequiresSubscription:true});
  }
  return projectRuntimeStatus(result);
}

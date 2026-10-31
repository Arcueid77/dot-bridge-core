import {validHostname} from '../router/live-contract.js';

export const diagnosticStages = ['validate','policy','transport','challenge','persist','complete'];
export const diagnosticReasons = ['invalid_request','callback_policy_required','transport_unavailable','challenge_failed','timeout','subscription_conflict','subscription_cancelled','storage_unavailable','subscribed'];
export const connectionStages = ['gateway','callback_policy','subscription','ready'];
export const connectionReasons = ['gateway_disconnected','callback_hosts_empty','callback_host_not_allowlisted','subscription_missing','subscription_expired','subscription_disabled','subscription_unknown','subscription_failed','ready'];
export const connectionNextSteps = ['check_gateway','approve_callback_hostname','subscribe_in_original_dot','renew_in_original_dot','inspect_subscription_diagnostics','none'];

export function subscriptionDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-5).flatMap(item => {
    if (!item || !diagnosticStages.includes(item.stage) || !diagnosticReasons.includes(item.reason) ||
        typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) ||
        !(item.code === null || (Number.isInteger(item.code) && item.code >= -32768 && item.code <= -32000)) ||
        !(item.hostname === null || validHostname(item.hostname))) return [];
    return [{at:new Date(item.at).toISOString(),stage:item.stage,code:item.code,reason:item.reason,hostname:item.hostname}];
  });
}

export function subscriptionStatus(record, now, diagnostics) {
  const validExpiry = Number.isSafeInteger(record?.expires) && record.expires >= 0 && record.expires <= 8640000000000000;
  const state = record == null ? 'none' : record.active === false ? 'disabled' : record.active !== true || !validExpiry ? 'unknown' : record.expires <= now ? 'expired' : 'active';
  return {state,expires_at:validExpiry ? new Date(record.expires).toISOString() : null,
    remaining_seconds:validExpiry ? Math.max(0,Math.floor((record.expires-now)/1000)) : null,
    renewal_owner:'host',diagnostics_available:diagnostics.length > 0};
}

export function connectionStatus({gatewayConnected,callbackHosts,subscription,diagnostics,callbackAllowed,legacyAliasPresent}) {
  let stage='ready',reason='ready',next_step='none';
  if (!gatewayConnected) {stage='gateway';reason='gateway_disconnected';next_step='check_gateway';}
  else if (!callbackHosts.length) {stage='callback_policy';reason='callback_hosts_empty';next_step='approve_callback_hostname';}
  else if (subscription.state === 'active' && !callbackAllowed) {stage='callback_policy';reason='callback_host_not_allowlisted';next_step='approve_callback_hostname';}
  else if (subscription.state !== 'active') {
    stage='subscription';
    if (subscription.state === 'expired') {reason='subscription_expired';next_step='renew_in_original_dot';}
    else if (subscription.state === 'disabled') {reason='subscription_disabled';next_step='subscribe_in_original_dot';}
    else if (subscription.state === 'unknown') {reason='subscription_unknown';next_step='inspect_subscription_diagnostics';}
    else if (diagnostics.length && diagnostics.at(-1).reason !== 'subscribed') {reason='subscription_failed';next_step='inspect_subscription_diagnostics';}
    else {reason='subscription_missing';next_step='subscribe_in_original_dot';}
  }
  return {stage,reason,next_step,callback_hosts_count:callbackHosts.length,diagnostic_history:diagnostics.length ? 'available' : 'unavailable',callback_hosts_configured:callbackHosts.length>0,
    ...(typeof legacyAliasPresent==='boolean'?{legacy_callback_alias_present:legacyAliasPresent}:{})};
}

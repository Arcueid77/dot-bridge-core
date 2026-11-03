export function legacyExperienceStatus(channel,config,management) {
  return {feedback_enabled:channel==='lark'?config.interaction?.enabled===true:true,typing:true,reactions:channel==='lark'&&config.interaction?.reactions===true,progressive_replies:channel==='qq'||config.interaction?.streaming===true,recent_context:true,management_commands:management?.enabled===true,configured_groups:channel==='lark'?(config.interaction?.groups??[]).filter(group=>group.enabled).length:0,hosted_dot_controls:false};
}

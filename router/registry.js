import { object } from './common.js';
const fields=['id','envPrefix','defaultPort','serviceKeyNewline','readinessTool','liveReadinessTool','backendSetupTool','readinessBackendTools','liveTools','event','scopes','limits','validateToolArguments','projectToolResult','matchesBackendOutputSchema','isCallbackPolicyError'];
const fail=()=>{throw new Error('Invalid trusted channel adapter');};
function immutable(value){
  if(Array.isArray(value))return Object.freeze(value.map(immutable));
  if(value&&typeof value==='object')return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,immutable(item)])));
  return value;
}
export function validateAdapter(adapter){
  try{object(adapter,fields,fields);}catch{fail();}
  if(!/^[a-z][a-z0-9_]{0,31}$/.test(adapter.id)||!/^[A-Z][A-Z0-9_]{0,31}$/.test(adapter.envPrefix)||
    !Number.isInteger(adapter.defaultPort)||adapter.defaultPort<1||adapter.defaultPort>65535||typeof adapter.serviceKeyNewline!=='boolean')fail();
  for(const name of ['validateToolArguments','projectToolResult','matchesBackendOutputSchema','isCallbackPolicyError'])if(typeof adapter[name]!=='function')fail();
  if(!Array.isArray(adapter.liveTools)||!Array.isArray(adapter.readinessBackendTools)||!Array.isArray(adapter.scopes)||!adapter.scopes.length||
     new Set(adapter.scopes).size!==adapter.scopes.length||adapter.scopes.some(s=>typeof s!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(s)))fail();
  const tools=[adapter.readinessTool,adapter.liveReadinessTool,adapter.backendSetupTool,...adapter.liveTools,...adapter.readinessBackendTools];
  for(const tool of tools)if(!tool||typeof tool.name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||!tool.inputSchema||typeof tool.inputSchema!=='object')fail();
  if(new Set(adapter.liveTools.map(t=>t.name)).size!==adapter.liveTools.length||adapter.liveTools.some(t=>[adapter.readinessTool.name,adapter.backendSetupTool.name].includes(t.name))||
     adapter.liveReadinessTool.name!==adapter.readinessTool.name||!adapter.event||adapter.event.name!==`${adapter.id}.message.created`||
     !adapter.event.inputSchema||!adapter.event.payloadSchema||JSON.stringify(adapter.event.delivery)!=='["webhook"]')fail();
  const limits=adapter.limits;
  try{object(limits,['request','response','body','bodyTools','requestTools','responseTools','timeouts'],['request','response','body','bodyTools','requestTools','responseTools','timeouts']);}catch{fail();}
  const names=new Set(tools.map(t=>t.name));
  for(const name of ['request','response','body'])if(!Number.isInteger(limits[name])||limits[name]<1024||limits[name]>12582912)fail();
  for(const name of ['bodyTools','requestTools','responseTools','timeouts']){
    if(!limits[name]||typeof limits[name]!=='object'||Array.isArray(limits[name]))fail();
    for(const [tool,value] of Object.entries(limits[name]))if(!names.has(tool)||!Number.isInteger(value)||value<1||value>(name==='timeouts'?45000:12582912))fail();
  }
  return immutable(adapter);
}
export function registerAdapters(adapters){
  if(!Array.isArray(adapters)||!adapters.length||adapters.length>16)fail();
  const result=adapters.map(validateAdapter),ids=new Set(),prefixes=new Set(),toolNames=new Set();
  for(const adapter of result){
    if(ids.has(adapter.id)||prefixes.has(adapter.envPrefix))fail();ids.add(adapter.id);prefixes.add(adapter.envPrefix);
    for(const name of [adapter.readinessTool.name,...adapter.liveTools.map(t=>t.name)]){if(toolNames.has(name))fail();toolNames.add(name);}
  }
  return Object.freeze(result);
}

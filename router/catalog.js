import { enabled } from './live-contract.js';
export const sameSchema=(actual,expected)=>{
  const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
  return canonical(actual)===canonical(expected);
};
export const toolCatalog=config=>[
  ...Object.entries(config.channels).map(([id,{adapter}])=>enabled(config,id)?adapter.liveReadinessTool:adapter.readinessTool),
  ...config.liveChannels.flatMap(id=>config.channels[id].adapter.liveTools)
];
export const eventCatalog=config=>config.liveChannels.map(id=>config.channels[id].adapter.event);
export const expectedBackendTools=(config,id,live)=>{const a=config.channels[id].adapter;return live?[...a.liveTools,a.backendSetupTool]:a.readinessBackendTools;};
export const matchesBackendOutputSchema=(config,id,name,actual,expected)=>config.channels[id].adapter.matchesBackendOutputSchema(name,actual,expected,sameSchema);

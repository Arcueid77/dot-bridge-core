import { enabled } from './live-contract.js';
import {canonicalValue} from './runtime.js';
export const sameSchema=(actual,expected)=>{
  return canonicalValue(actual)===canonicalValue(expected);
};
export const toolCatalog=config=>[
  ...Object.entries(config.channels).map(([id,{adapter}])=>enabled(config,id)?adapter.liveReadinessTool:adapter.readinessTool),
  ...config.liveChannels.flatMap(id=>config.channels[id].adapter.liveTools)
];
export const eventCatalog=config=>config.liveChannels.map(id=>config.channels[id].adapter.event);
export const expectedBackendTools=(config,id,live)=>{const a=config.channels[id].adapter;return live?[...a.liveTools,a.backendSetupTool]:a.readinessBackendTools;};
export const matchesBackendOutputSchema=(config,id,name,actual,expected)=>config.channels[id].adapter.matchesBackendOutputSchema(name,actual,expected,sameSchema);

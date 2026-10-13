export class BridgeError extends Error {
  constructor(message, { status = 400, code = -32602, data } = {}) {
    super(message); Object.assign(this, { status, code, data });
  }
}
export function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new BridgeError('Invalid object fields');
  }
  return value;
}
export const VERSION = '2026-07-28';
export const OWNER = 'tunnel-owner:dot-bridge';
export const SERVICE_HEADER = 'x-dot-bridge-service-key';
export const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
export const metadata = () => ({ 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} });
export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result,
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'dot-bridge-tunnel', version: '0.1.0' } } } });
export const RICH_TOOL_RESULT = Symbol.for('dot-bridge.core.closed-adapter-tool-result.v1');
export const toolResult = value => value?.[RICH_TOOL_RESULT] ? {content:value.content,structuredContent:value.value,isError:false} : ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });

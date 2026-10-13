// Original strict MCP validator copied unchanged from dot-qq-bridge/src/server.js.
// Do not weaken header, metadata, version or Accept checks for tunnel clients.
import { TextDecoder } from 'node:util';
import { BridgeError, object, VERSION } from './common.js';

function decodedName(value) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('=?base64?')) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) return undefined;
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return undefined; }
}
export function validateMcp(request, headers) {
  object(request, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (Object.hasOwn(request, 'id') && !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id))))) {
    throw new BridgeError('Invalid JSON-RPC request', { code: -32600 });
  }
  const params = request.params ?? {}, meta = params._meta;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !meta || typeof meta !== 'object' || Array.isArray(meta) ||
      typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string' || !meta['io.modelcontextprotocol/clientCapabilities'] ||
      typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object' || Array.isArray(meta['io.modelcontextprotocol/clientCapabilities'])) {
    throw new BridgeError('Required per-request MCP metadata is missing');
  }
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== request.method ||
      (['tools/call', 'resources/read', 'prompts/get'].includes(request.method) && decodedName(headers['mcp-name']) !== (params.name ?? params.uri))) {
    throw new BridgeError('MCP header/body mismatch or required header missing', { code: -32020 });
  }
  if (version !== VERSION) throw new BridgeError('Unsupported MCP protocol version', { code: -32022, data: { supported: [VERSION] } });
  const accept = headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) throw new BridgeError('Accept must include application/json and text/event-stream', { status: 406 });
  return params;
}

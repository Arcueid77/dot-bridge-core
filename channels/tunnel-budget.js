// Secure MCP Tunnel limits the complete serialized control-plane envelope, not
// only its MCP payload. See https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#limits.
export const TUNNEL_ENVELOPE_BYTES = 10 * 1024 * 1024;
export const TUNNEL_METADATA_RESERVE_BYTES = 256 * 1024;
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_BASE64 = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
// Rich results contain their transcript/metadata in both structuredContent and
// a text block. Reserve room for their worst-case JSON escaping and UTF-8.
export const MEDIA_METADATA_BYTES = 512 * 1024;
export const MEDIA_RPC_LIMIT = MAX_MEDIA_BASE64 + MEDIA_METADATA_BYTES;

// The official client uses raw JSON for jsonrpc / resp_json. Keeping this
// stronger bound also accommodates a Base64-encoded HTTP body without using
// all of the default control-plane envelope allowance.
if (Math.ceil(MEDIA_RPC_LIMIT / 3) * 4 + TUNNEL_METADATA_RESERVE_BYTES >= TUNNEL_ENVELOPE_BYTES) {
  throw new Error('Media budget exceeds the default tunnel envelope allowance');
}

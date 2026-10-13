// Called only AFTER original raw headers and the real socket/service key are
// validated. Caller identity/context/proxy/cookie/bearer fields are not authority.
// Retain only fields used by HTTP/MCP validation; never interpret discarded values.
const retained = new Set(['host', 'origin', 'content-type', 'content-length', 'content-encoding',
  'transfer-encoding', 'accept', 'mcp-method', 'mcp-name', 'mcp-protocol-version', 'mcp-session-id']);
export function retainValidationHeaders(req) {
  const filteredHeaders = Object.create(null), filteredRaw = [];
  for (const [name, value] of Object.entries(req.headers)) if (retained.has(name.toLowerCase())) filteredHeaders[name] = value;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (retained.has(req.rawHeaders[i].toLowerCase())) filteredRaw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
  req.headers = filteredHeaders;
  req.rawHeaders = filteredRaw;
}

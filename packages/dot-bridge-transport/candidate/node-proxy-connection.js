// Internal bounded connection core. Callback validation belongs to the explicit
// owner-message wrapper; this core is not a default production route.
// Hostname CONNECT/TLS does not attest the proxy final destination IP.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {isIP} from 'node:net';
import {CallbackTransportError,responseHeaders} from '../transport.js';
const fail=code=>new CallbackTransportError(code);
function safeCode(error) {
  if(error instanceof CallbackTransportError)return error.code;
  const code=typeof error?.code==='string'?error.code:'';
  return code.startsWith('ERR_TLS')||code.includes('CERT')||code.startsWith('DEPTH_ZERO')||code.startsWith('SELF_SIGNED')?'tls_failed':'connection_failed';
}
export function makeNodeProxyConnection({ca}={}) {
  return async function connect(url,proxy,request) {
    const method=request?.method;
    if(!(url instanceof URL)||!(proxy instanceof URL)||!['POST','GET'].includes(method)||
      (method==='GET'&&request.body?.length!==0))throw fail('invalid_input');
    const body = Buffer.from(request.body), headers = { ...request.headers };
    return new Promise((resolve, reject) => {
      let settled = false, connectReq, req, res, targetAgent, proxyAgent, timer;
      const sockets = new Set();
      const track = socket => {
        if (!socket) return socket;
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        socket.on('error', error => finish(error));
        if (settled) socket.destroy();
        return socket;
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); request.signal.removeEventListener('abort', abort);
        try { res?.destroy(); } catch {}
        for (const item of [req, connectReq, targetAgent, proxyAgent, ...sockets]) { try { item?.destroy(); } catch {} }
        body.fill(0);
        error ? reject(fail(safeCode(error))) : resolve(result);
      };
      const active = () => { if (settled || request.signal.aborted) throw fail('aborted'); };
      const guarded = operation => {
        active();
        return request.beforeConnect(() => { active(); return operation(); });
      };
      const run = operation => {
        try {
          const result = guarded(operation);
          if (result && typeof result.then === 'function') result.catch(error => finish(error));
        } catch (error) { finish(error); }
      };
      const abort = () => finish(fail('aborted'));
      request.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(fail('timeout')), request.timeoutMs);
      if (request.signal.aborted) { abort(); return; }
      const receive = incoming => {
        res = incoming;
        if (settled) { res.destroy(); return; }
        let projected;
        try {
          active();
          if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) throw fail('invalid_response');
          if (res.statusCode >= 300 && res.statusCode < 400) throw fail('redirect_rejected');
          projected = responseHeaders(res, request.maxBytes);
        } catch (error) { finish(error); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > request.maxBytes) { finish(fail('response_too_large')); return; }
          chunks.push(chunk);
        });
        res.once('aborted', () => finish(fail('invalid_response')));
        res.once('error', () => finish(fail('invalid_response')));
        res.once('end', () => {
          if (settled) return;
          if (!res.complete || (projected['content-length'] !== undefined && Number(projected['content-length']) !== size)) {
            finish(fail('invalid_response')); return;
          }
          run(() => finish(null, { status: res.statusCode, headers: projected, body: Buffer.concat(chunks, size) }));
        });
      };
      const tlsOptions = { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca === undefined ? {} : { ca }) };
      const sendApplicationRequest = secureSocket => run(() => {
        // This private one-use Agent accepts only the already authenticated TLS
        // tunnel. It has no DNS/dial fallback or address-selection behavior.
        targetAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0, ...tlsOptions });
        let taken = false;
        targetAgent.createConnection = () => {
          active();
          if (taken || !secureSocket.authorized || secureSocket.destroyed) throw fail('tls_failed');
          taken = true; return secureSocket;
        };
        req = https.request(url, { method, headers, agent: targetAgent, servername: url.hostname, ...tlsOptions,
          maxHeaderSize: 8192, insecureHTTPParser: false, joinDuplicateHeaders: false }, receive);
        // Zero retains every raw pair under the byte limit. Validation rejects
        // more than 32 pairs instead of silently truncating and accepting them.
        req.maxHeadersCount = 0;
        req.once('error', error => finish(error));
        req.once('upgrade', (incoming, socket) => { incoming.destroy(); socket.destroy(); finish(fail('invalid_response')); });
        req.once('close', () => { if (!settled && !res?.complete) finish(fail('invalid_response')); });
        run(() => req.end(body));
      });
      const connected = (response, socket, head) => {
        track(socket);
        if (settled) { socket.destroy(); return; }
        try {
          active();
          if (response.statusCode !== 200 || head.length || !response.complete) throw fail('connection_failed');
          const projected = responseHeaders(response, request.maxBytes);
          if (projected['content-length'] !== undefined || projected['transfer-encoding'] !== undefined ||
              projected['content-encoding'] !== undefined) throw fail('invalid_response');
        } catch (error) { finish(error); return; }
        // A successful CONNECT alone is not TLS identity or final-IP proof.
        run(() => {
          const secure = track(tls.connect({ socket, servername: url.hostname, ...tlsOptions }, () => {
            if (settled) { secure.destroy(); return; }
            if (!secure.authorized) { finish(fail('tls_failed')); return; }
            sendApplicationRequest(secure);
          }));
        });
      };
      // Node's built-in proxy Agent leaves CONNECT headers unbounded and does
      // not forward its TLS options to an HTTPS proxy. Use the public native
      // HTTP parser for hostname CONNECT so BOTH hops are bounded and strict.
      run(() => {
        const encrypted = proxy.protocol === 'https:';
        const proxyHost = proxy.hostname.startsWith('[') ? proxy.hostname.slice(1, -1) : proxy.hostname;
        const Agent = encrypted ? https.Agent : http.Agent;
        class GuardedProxyAgent extends Agent {
          createConnection(connectionOptions, callback) {
            try {
              const result = guarded(() => {
                const socket = track(super.createConnection(connectionOptions));
                callback(null, socket);
              });
              if (result && typeof result.then === 'function') result.catch(error => callback(fail(safeCode(error))));
            } catch (error) { queueMicrotask(() => callback(fail(safeCode(error)))); }
            return undefined;
          }
        }
        proxyAgent = new GuardedProxyAgent({ keepAlive: false, ...(encrypted ? { maxCachedSessions: 0, ...tlsOptions } : {}) });
        const connectHeaders = { host: `${url.hostname}:443`, connection: 'close' };
        if (request.proxy.authorization != null) connectHeaders['proxy-authorization'] = request.proxy.authorization;
        connectReq = (encrypted ? https : http).request(proxy, { method: 'CONNECT', path: `${url.hostname}:443`, headers: connectHeaders,
          agent: proxyAgent, maxHeaderSize: 8192, insecureHTTPParser: false, joinDuplicateHeaders: false,
          ...(encrypted ? { servername: isIP(proxyHost) ? '' : proxyHost, ...tlsOptions } : {}) });
        connectReq.maxHeadersCount = 0;
        connectReq.once('socket', track);
        connectReq.once('error', error => finish(error));
        connectReq.once('connect', connected);
        connectReq.once('response', incoming => { incoming.destroy(); finish(fail('connection_failed')); });
        connectReq.once('upgrade', (incoming, socket) => { incoming.destroy(); socket.destroy(); finish(fail('invalid_response')); });
        run(() => connectReq.end());
      });
    });
  };
}

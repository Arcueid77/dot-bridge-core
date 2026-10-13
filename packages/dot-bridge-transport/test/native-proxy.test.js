import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {makeCallbackTransport, CallbackTransportError, TRANSPORT_ERROR_CODES, validateCallbackUrl} from '../index.js';
import {configuredProxy, bypassMatches} from '../transport.js';
import {makeNodeProxyConnection} from '../candidate/node-proxy-connection.js';
const fixtureAdapter=({ca}={})=>({send:(target,request)=>makeNodeProxyConnection({ca})(new URL(target.url),new URL(request.proxy.url),{...request,method:'POST'})});

// Completely synthetic, offline integration tests. The only real sockets are
// loopback. The proxy routes the fixed test authority to the fixture, regardless
// of the adapter's synthetic public address input. This proves mechanics, not
// the platform proxy's DNS/SSRF destination policy or production readiness.
const HOST = 'callback.example.test';
const TARGET = `https://${HOST}/path?synthetic=only`;
const BODY = Buffer.from('{"kind":"synthetic"}');
const OPTIONS = {method:'POST', headers:{'content-type':'application/json'}, body:BODY,
  hosts:[HOST], beforeConnect(){}};
const PUBLIC_ANSWERS = [{address:'93.184.216.34', family:4}];

// Explicit test inputs for the isolated protocol adapter. These addresses are
// never DNS results and never evidence of a platform's final-hop policy. The
// shared production transport is deliberately NOT used as the fixture sender.
function syntheticTarget(raw, addresses=PUBLIC_ANSWERS) {
  assert.equal(raw, TARGET, 'the protocol fixture accepts only its fixed synthetic target');
  const url = validateCallbackUrl(raw);
  return Object.freeze({url:url.href, hostname:url.hostname, port:443,
    addresses:Object.freeze(addresses.map(address => Object.freeze({...address}))),
    selectedAddress:Object.freeze({...addresses[0]}),
    tls:Object.freeze({servername:url.hostname, rejectUnauthorized:true, minVersion:'TLSv1.2'}),
    destinationBinding:'test_fixture_only'});
}

// Adapt the fixture's approval hook to the low-level operation gate contract.
// The candidate core itself owns cancellation and the total protocol deadline.
function fixtureGate(beforeConnect) {
  return operation => {
    let approval;
    try { approval = beforeConnect(); }
    catch { throw new CallbackTransportError('gate_failed'); }
    if (approval && typeof approval.then === 'function') {
      return Promise.resolve(approval).then(() => operation?.(), () => {
        throw new CallbackTransportError('gate_failed');
      });
    }
    return operation?.();
  };
}
let certDir, goodIdentity, wrongIdentity, localProxyIdentity;

function certificate(name, san, kind='DNS') {
  const keyPath = join(certDir, `${name}.key.pem`);
  const certPath = join(certDir, `${name}.cert.pem`);
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=${kind}:${san}`,
    '-keyout', keyPath, '-out', certPath], {stdio:'ignore'});
  return {key:readFileSync(keyPath), cert:readFileSync(certPath), certPath};
}
before(() => {
  certDir = mkdtempSync(join(tmpdir(), 'callback-node-proxy-test-'));
  goodIdentity = certificate('good', HOST);
  wrongIdentity = certificate('wrong-san', 'wrong.example.test');
  localProxyIdentity = certificate('local-proxy', '127.0.0.1', 'IP');
});
after(() => rmSync(certDir, {recursive:true, force:true}));

async function until(predicate, message, timeoutMs=1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {server.removeListener('error', reject); resolve();});
});
const close = server => new Promise(resolve => server.close(resolve));
const okReply = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}';

async function fixture(t, {identity=goodIdentity, mode='tunnel', respond, secureProxy=false, proxyIdentity=localProxyIdentity, connectDelayMs=0}={}) {
  const sockets = new Set(), connects = [], requests = [], tlsNames = [], unexpected = [];
  let proxyConnections = 0, applicationBytes = 0, stalledTlsBytes = 0;
  const timers = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const target = tls.createServer({key:identity.key, cert:identity.cert}, socket => {
    tlsNames.push(socket.servername);
    let input = Buffer.alloc(0), delivered = false;
    socket.on('error', () => {});
    socket.on('data', bytes => {
      applicationBytes += bytes.length;
      if (delivered) return;
      input = Buffer.concat([input, bytes]);
      const boundary = input.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const lines = input.subarray(0, boundary).toString('latin1').split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const length = Number(headers['content-length'] ?? 0);
      if (input.length < boundary + 4 + length) return;
      delivered = true;
      const request = {line:lines[0], headers, body:input.subarray(boundary + 4, boundary + 4 + length)};
      requests.push(request);
      if (respond) respond(socket, request);
      else socket.end(okReply);
    });
  });
  target.on('connection', track);
  target.on('tlsClientError', () => {});
  const proxyRequest = (_req, res) => {
    unexpected.push('non-CONNECT proxy request'); res.writeHead(400); res.end();
  };
  const proxy = secureProxy ? https.createServer({key:proxyIdentity.key, cert:proxyIdentity.cert}, proxyRequest)
    : http.createServer(proxyRequest);
  proxy.on('tlsClientError', () => {});
  proxy.on('connection', socket => {proxyConnections++; track(socket);});
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (request, client, head) => {
    connects.push({authority:request.url, headers:request.headers});
    if (request.url !== `${HOST}:443`) {
      unexpected.push('unexpected CONNECT authority'); client.destroy(); return;
    }
    if (mode === 'connect-stall') {
      // Consume peer EOF; CONNECT sockets are detached from HTTP lifecycle.
      client.on('end', () => client.end()); client.resume(); return;
    }
    if (mode === 'connect-drop') {client.destroy(); return;}
    if (mode === 'connect-reject') {
      client.end('HTTP/1.1 407 SYNTHETIC_PRIVATE_PROXY_REASON\r\nContent-Length: 28\r\nX-Private: SYNTHETIC_HEADER\r\n\r\nSYNTHETIC_PRIVATE_PROXY_BODY');
      return;
    }
    if (mode === 'tls-stall') {
      client.on('data', bytes => {stalledTlsBytes += bytes.length;});
      client.on('end', () => client.end()); client.resume();
      const establish = () => {if (!client.destroyed) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');};
      if (connectDelayMs) {
        const timer = setTimeout(() => {timers.delete(timer); establish();}, connectDelayMs);
        timers.add(timer);
      } else establish();
      return;
    }
    // The CONNECT destination is NEVER resolved or used as a socket endpoint.
    const upstream = track(net.connect(target.address().port, '127.0.0.1', () => {
      let response = 'HTTP/1.1 200 Connection Established\r\n';
      if (mode === 'connect-large-header') response += 'X-Large: ' + 'x'.repeat(8193) + '\r\n';
      if (mode === 'connect-many-headers') response += Array.from({length:33}, (_,i) => `X-${i}: x\r\n`).join('');
      response += '\r\n';
      if (mode === 'connect-inject-head') response += 'SYNTHETIC_UNEXPECTED_TUNNEL_BYTES';
      client.write(response);
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    }));
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await listen(target);
  await listen(proxy);
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(proxy), close(target)]);
  });
  const proxyUrl = `${secureProxy ? 'https' : 'http'}://127.0.0.1:${proxy.address().port}`;
  function sender({ca=secureProxy ? Buffer.concat([identity.cert, proxyIdentity.cert]) : identity.cert,
    adapter=fixtureAdapter({ca}), proxyEnv={HTTPS_PROXY:proxyUrl},
    addresses=PUBLIC_ANSWERS, timeoutMs=1000, maxBytes=8192}={}) {
    const proxy = configuredProxy(proxyEnv);
    assert.equal(proxy?.url.origin, proxyUrl, 'the adapter may connect only to this loopback fixture');
    return async (raw, {method='POST', headers={}, body=Buffer.alloc(0), beforeConnect=()=>{}, signal}={}) => {
      const target = syntheticTarget(raw, addresses);
      return adapter.send(target, Object.freeze({method,
        headers:Object.freeze({...headers, host:target.hostname, 'content-length':String(body.length),
          accept:'application/json', 'accept-encoding':'identity'}),
        body:Buffer.from(body), proxy:Object.freeze({url:proxy.url.href, authorization:proxy.authorization ?? null}),
        beforeConnect:fixtureGate(beforeConnect), signal:signal ?? new AbortController().signal,
        timeoutMs, maxBytes}));
    };
  }
  async function settled() {
    await until(() => sockets.size === 0, 'candidate left a live fixture socket after settlement');
    assert.deepEqual(unexpected, [], 'candidate attempted an unexpected proxy destination or protocol');
  }
  return {target, proxy, proxyUrl, connects, requests, tlsNames, sockets, sender, settled,
    get proxyConnections(){return proxyConnections;}, get applicationBytes(){return applicationBytes;},
    get stalledTlsBytes(){return stalledTlsBytes;}};
}

function sanitizedFailure(error) {
  assert.ok(error instanceof CallbackTransportError);
  assert.ok(TRANSPORT_ERROR_CODES.includes(error.code));
  assert.equal(error.reason, error.code);
  assert.equal(error.message, 'Callback transport rejected or failed');
  assert.equal(error.cause, undefined);
  const rendered = `${String(error)} ${JSON.stringify(error)}`;
  for (const secret of [HOST, '127.0.0.1', 'synthetic-user', 'synthetic-pass',
    'SYNTHETIC_PRIVATE', 'SYNTHETIC_HEADER', 'private-path']) assert.ok(!rendered.includes(secret));
  return true;
}
async function rejected(send, extra={}, predicate=sanitizedFailure) {
  return assert.rejects(send(TARGET, {...OPTIONS, ...extra}), predicate);
}

// Use real Node HTTPS/Agent/CONNECT/TLS, never an injected request implementation.
test('native candidate CONNECTs once to the original hostname and preserves TLS, HTTP identity and body', async t => {
  const f = await fixture(t);
  const out = await f.sender()(TARGET, OPTIONS);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, Buffer.from('{}'));
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(f.connects.length, 1);
  assert.equal(f.connects[0].authority, `${HOST}:443`);
  assert.equal(net.isIP(f.connects[0].authority.slice(0, -4)), 0);
  assert.deepEqual(f.tlsNames, [HOST]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].line, 'POST /path?synthetic=only HTTP/1.1');
  assert.equal(f.requests[0].headers.host, HOST);
  assert.equal(f.requests[0].headers['accept-encoding'], 'identity');
  assert.equal(f.requests[0].headers['content-length'], String(BODY.length));
  assert.equal(f.requests[0].headers['proxy-authorization'], undefined);
  assert.deepEqual(f.requests[0].body, BODY);
  await f.settled();
  assert.equal(f.proxyConnections, 1);
});

test('native candidate validates both trust and original-name SAN, without retry or plaintext fallback', async t => {
  for (const kind of ['wrong-ca', 'wrong-san']) await t.test(kind, async t => {
    const f = await fixture(t, {identity:kind === 'wrong-san' ? wrongIdentity : goodIdentity});
    const ca = wrongIdentity.cert;
    await rejected(f.sender({ca}));
    await f.settled();
    assert.equal(f.connects.length, 1);
    assert.equal(f.proxyConnections, 1);
    assert.equal(f.requests.length, 0);
  });
});

function nodeChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env, stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('isolated trust test timed out'));}, 5000);
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('close', code => {clearTimeout(timer); resolve({code, stdout, stderr});});
  });
}
test('omitting ca preserves Node default trust including NODE_EXTRA_CA_CERTS, with no global trust mutation', async t => {
  const f = await fixture(t);
  const candidateModule = new URL('../candidate/node-proxy-connection.js', import.meta.url).href;
  const script = `
    import {makeNodeProxyConnection} from ${JSON.stringify(candidateModule)};
    const fixtureAdapter=()=>({send:(target,request)=>makeNodeProxyConnection()(new URL(target.url),new URL(request.proxy.url),request)});
    // Fixed synthetic target and loopback proxy, not shared production preflight.
    const target = ${JSON.stringify(syntheticTarget(TARGET))};
    const adapter = fixtureAdapter();
    try { const result = await adapter.send(target, {method:'POST',headers:{'content-type':'application/json',
      host:${JSON.stringify(HOST)},'content-length':'2',accept:'application/json','accept-encoding':'identity'},
      body:Buffer.from('{}'),proxy:{url:${JSON.stringify(f.proxyUrl)},authorization:null},
      signal:new AbortController().signal,timeoutMs:1000,maxBytes:8192,beforeConnect:operation=>operation?.()});
      process.stdout.write(result.status === 200 ? 'trusted' : 'unexpected-status');
    } catch (error) { process.stdout.write('rejected:' + error.code); }
  `;
  // No real proxy variables, credentials, NODE_OPTIONS, or global CA changes.
  const untrusted = await nodeChild(script, {});
  assert.equal(untrusted.code, 0);
  assert.match(untrusted.stdout, /^rejected:/);
  assert.equal(untrusted.stderr, '');
  await f.settled();
  const trusted = await nodeChild(script, {NODE_EXTRA_CA_CERTS:goodIdentity.certPath});
  assert.equal(trusted.code, 0);
  assert.equal(trusted.stdout, 'trusted');
  assert.equal(trusted.stderr, '');
  await f.settled();
  assert.equal(f.connects.length, 2);
  assert.equal(f.requests.length, 1);
});

test('HTTPS proxy uses verified TLS and never bypasses a bad proxy certificate', async t => {
  for (const kind of ['trusted', 'wrong-ca', 'wrong-san']) await t.test(kind, async t => {
    const f = await fixture(t, {secureProxy:true, proxyIdentity:kind === 'wrong-san' ? wrongIdentity : localProxyIdentity});
    const send = kind === 'wrong-ca' ? f.sender({ca:goodIdentity.cert}) : f.sender();
    if (kind === 'trusted') {
      assert.equal((await send(TARGET, OPTIONS)).status, 200);
      assert.equal(f.connects.length, 1);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.tlsNames, [HOST]);
    } else {
      await rejected(send);
      assert.equal(f.connects.length, 0, 'CONNECT must not reach an unverified HTTPS proxy');
      assert.equal(f.requests.length, 0);
    }
    await f.settled();
    assert.equal(f.proxyConnections, 1);
  });
});

test('CONNECT non-200 is sanitized, cannot leak synthetic proxy auth, and never retries', async t => {
  const f = await fixture(t, {mode:'connect-reject'});
  await rejected(f.sender({proxyEnv:{HTTPS_PROXY:f.proxyUrl.replace('http://', 'http://synthetic-user:synthetic-pass@')}}));
  await f.settled();
  assert.equal(f.connects.length, 1);
  assert.equal(f.proxyConnections, 1);
  assert.equal(f.requests.length, 0);
});

test('CONNECT response headers are bounded and unexpected tunnel head bytes are never discarded', async t => {
  for (const mode of ['connect-large-header', 'connect-many-headers', 'connect-inject-head']) {
    await t.test(mode, async t => {
      const f = await fixture(t, {mode});
      await rejected(f.sender(), {}, error => {
        sanitizedFailure(error);
        assert.notEqual(error.code, 'timeout', 'bad CONNECT response must reject immediately');
        return true;
      });
      await f.settled();
      assert.equal(f.connects.length, 1);
      assert.equal(f.proxyConnections, 1);
      assert.equal(f.requests.length, 0);
    });
  }
});

test('proxy authorization is sent only on CONNECT and never forwarded to the TLS endpoint', async t => {
  const f = await fixture(t);
  const proxyEnv = {HTTPS_PROXY:f.proxyUrl.replace('http://', 'http://synthetic-user:synthetic-pass@')};
  assert.equal((await f.sender({proxyEnv})(TARGET, OPTIONS)).status, 200);
  assert.equal(f.connects[0].headers['proxy-authorization'], `Basic ${Buffer.from('synthetic-user:synthetic-pass').toString('base64')}`);
  assert.equal(f.requests[0].headers['proxy-authorization'], undefined);
  await f.settled();
});

test('redirects are rejected before following and an ordinary 503 is returned without retry', async t => {
  for (const status of [301,302,307,308,503]) await t.test(String(status), async t => {
    const f = await fixture(t, {respond:socket => socket.end(`HTTP/1.1 ${status} Synthetic\r\nLocation: https://other.example.test/private-path\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)});
    if (status === 503) assert.equal((await f.sender()(TARGET, OPTIONS)).status, 503);
    else await rejected(f.sender());
    await f.settled();
    assert.equal(f.connects.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.proxyConnections, 1);
  });
});

test('CONNECT reset fails after exactly one connection with no retry or direct fallback', async t => {
  const f = await fixture(t, {mode:'connect-drop'});
  await rejected(f.sender());
  await f.settled();
  assert.equal(f.connects.length, 1);
  assert.equal(f.proxyConnections, 1);
  assert.equal(f.requests.length, 0);
});

test('response bounds and malformed wire headers/encoding/truncation fail closed', async t => {
  const cases = [
    ['oversized-declared', 'HTTP/1.1 200 OK\r\nContent-Length: 33\r\n\r\n', false],
    ['oversized-stream', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n21\r\n' + 'x'.repeat(33) + '\r\n', false],
    ['oversized-header', 'HTTP/1.1 200 OK\r\nX-Large: ' + 'x'.repeat(8193) + '\r\nContent-Length: 0\r\n\r\n'],
    ['too-many-headers', 'HTTP/1.1 200 OK\r\n' + Array.from({length:33}, (_,i) => `X-${i}: x\r\n`).join('') + 'Content-Length: 0\r\n\r\n'],
    ['duplicate-content-type', 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}'],
    ['duplicate-content-length', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}'],
    ['transfer-and-length', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n0\r\n\r\n'],
    ['gzip-content-encoding', 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}'],
    ['invalid-transfer-encoding', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\nConnection: close\r\n\r\n{}'],
    ['truncated-fixed-length', 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}'],
    ['truncated-chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}'],
    ['protocol-upgrade', 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n']
  ];
  for (const [name, wire, end=true] of cases) await t.test(name, async t => {
    const f = await fixture(t, {respond:socket => end ? socket.end(wire) : socket.write(wire)});
    const start = Date.now();
    await rejected(f.sender({maxBytes:32}), {}, error => {
      sanitizedFailure(error);
      assert.notEqual(error.code, 'timeout', 'response validation must reject without waiting for the total deadline');
      return true;
    });
    assert.ok(Date.now() - start < 900, 'response validation unexpectedly waited for the deadline');
    await f.settled();
    assert.equal(f.connects.length, 1);
    assert.equal(f.requests.length, 1);
  });
});

test('identity encoding, legal chunking and the exact response limit remain usable', async t => {
  for (const framing of ['length', 'chunked']) await t.test(framing, async t => {
    const body = 'x'.repeat(32);
    const wire = framing === 'length' ? `Content-Length: 32\r\n\r\n${body}` : `Transfer-Encoding: chunked\r\n\r\n20\r\n${body}\r\n0\r\n\r\n`;
    const f = await fixture(t, {respond:socket => socket.end(`HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\nConnection: close\r\n${wire}`)});
    assert.deepEqual((await f.sender({maxBytes:32})(TARGET, OPTIONS)).body, Buffer.from(body));
    await f.settled();
  });
});

test('abort and total deadline cover pending CONNECT, TLS, response headers and response body without socket leaks', async t => {
  for (const stage of ['connect', 'tls', 'headers', 'body']) for (const action of ['abort', 'timeout']) {
    await t.test(`${action}-${stage}`, async t => {
      const f = await fixture(t, {
        mode:stage === 'connect' ? 'connect-stall' : stage === 'tls' ? 'tls-stall' : 'tunnel',
        respond:socket => {if (stage === 'body') socket.write('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx');}
      });
      const controller = new AbortController();
      const start = Date.now();
      const failed = rejected(f.sender({timeoutMs:action === 'timeout' ? 120 : 1000}),
        {signal:controller.signal}, error => {
          sanitizedFailure(error);
          assert.equal(error.code, action === 'timeout' ? 'timeout' : 'aborted');
          return true;
        });
      await until(() => stage === 'connect' ? f.connects.length > 0 : stage === 'tls' ? f.stalledTlsBytes > 0 : f.requests.length > 0,
        `request did not reach ${stage}`);
      if (action === 'abort') controller.abort();
      await failed;
      assert.ok(Date.now() - start < 900, 'cancellation or total deadline did not settle promptly');
      await f.settled();
      assert.equal(f.connects.length, 1);
      assert.equal(f.proxyConnections, 1);
      // A late, local fixture action cannot revive the canceled adapter.
      await delay(10);
      assert.equal(f.proxyConnections, 1);
      assert.equal(f.sockets.size, 0);
    });
  }
});

test('shared production preflight rejects the native candidate before DNS, approval gates or sockets', async t => {
  const f = await fixture(t);
  const native = fixtureAdapter({ca:goodIdentity.cert});
  let lookups = 0, approvals = 0, adapterCalls = 0;
  const send = makeCallbackTransport({proxyEnv:{HTTPS_PROXY:f.proxyUrl},
    lookup:async () => {lookups++; return PUBLIC_ANSWERS;},
    request:() => assert.fail('direct fallback is forbidden'),
    managedAdapter:{send(target, request){adapterCalls++; return native.send(target, request);}}});
  const state = send.preflight();
  assert.equal(state.ready, false);
  assert.equal(state.mode, 'blocked');
  assert.equal(state.reason, 'proxy_policy_unverified');
  assert.equal(state.destination_binding, 'unverified');
  await rejected(send, {beforeConnect(){approvals++;}}, error => {
    sanitizedFailure(error);
    assert.equal(error.code, 'proxy_policy_unverified');
    return true;
  });
  assert.equal(lookups, 0);
  assert.equal(approvals, 0);
  assert.equal(adapterCalls, 0);
  assert.equal(f.proxyConnections, 0);
  assert.equal(f.requests.length, 0);
  await f.settled();
});

test('the native total protocol deadline includes delayed CONNECT before a stalled target TLS handshake', async t => {
  const f = await fixture(t, {mode:'tls-stall', connectDelayMs:110});
  const start = Date.now();
  await rejected(f.sender({timeoutMs:180}), {}, error => {
    sanitizedFailure(error);
    assert.equal(error.code, 'timeout');
    return true;
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 160, 'total deadline settled before the configured timeout');
  assert.ok(elapsed < 260, 'TLS appears to restart the elapsed total protocol deadline');
  assert.ok(f.stalledTlsBytes > 0, 'the delayed CONNECT never reached the target TLS handshake');
  assert.equal(f.connects.length, 1);
  assert.equal(f.proxyConnections, 1);
  assert.equal(f.requests.length, 0);
  await f.settled();
});

test('already-aborted and revoked requests make no network connection', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await rejected(f.sender(), {signal:controller.signal}, error => error.code === 'aborted');
  await rejected(f.sender(), {beforeConnect(){throw new Error('SYNTHETIC_PRIVATE_REVOKED');}}, error => error.code === 'gate_failed');
  let revoked = false;
  const native = fixtureAdapter({ca:goodIdentity.cert});
  const adapter = {send(target, request) {revoked = true; return native.send(target, request);}};
  await rejected(f.sender({adapter}), {beforeConnect(){if (revoked) throw new Error('SYNTHETIC_PRIVATE_REVOKED');}}, error => error.code === 'gate_failed');
  await delay(20);
  assert.equal(f.connects.length, 0);
  assert.equal(f.proxyConnections, 0);
  assert.equal(f.requests.length, 0);
  await f.settled();
});

test('abort/deadline fence pending asynchronous gates and their late resolution', async t => {
  // Isolated candidate gates: CONNECT request, proxy socket, CONNECT send,
  // target TLS, application request and body send. No shared DNS/preflight gates.
  // A late approval at any gate must never revive canceled work.
  for (const [stage, gate] of [['request',1], ['connection',2], ['connect-send',3],
    ['target-tls',4], ['application-request',5], ['application-body',6]]) {
    for (const action of ['abort', 'timeout']) await t.test(`${action}-${stage}-gate`, async t => {
      const f = await fixture(t);
      const controller = new AbortController();
      let checks = 0, paused = false, release;
      const approval = new Promise(resolve => {release = resolve;});
      const failed = rejected(f.sender({timeoutMs:action === 'timeout' ? 120 : 1000}), {
        signal:controller.signal,
        beforeConnect(){if (++checks === gate) {paused = true; return approval;}}
      }, error => error.code === (action === 'timeout' ? 'timeout' : 'aborted'));
      await until(() => paused, 'candidate did not reach the selected asynchronous gate');
      if (action === 'abort') controller.abort();
      await failed;
      await f.settled();
      assert.equal(f.requests.length, 0, 'body was delivered before its pending gate approved');
      assert.equal(f.applicationBytes, 0, 'application bytes were sent before the pending gate approved');
      if (gate <= 2) assert.equal(f.proxyConnections, 0, 'a pending connection gate opened a socket');
      const connections = f.proxyConnections;
      release();
      await delay(25);
      await f.settled();
      assert.equal(f.proxyConnections, connections, 'late gate approval revived the network request');
      assert.equal(f.requests.length, 0, 'late gate approval sent a canceled body');
      assert.equal(f.applicationBytes, 0, 'late gate approval sent canceled application bytes');
    });
  }
});

test('callback adapter snapshots fixed POST across mutable-DI asynchronous gates', async t => {
  const f = await fixture(t), native = fixtureAdapter({ca:goodIdentity.cert});
  for (const changedMethod of ['GET', 'DELETE']) {
    const adapter = {send(target, request) {
      const mutable = {...request, beforeConnect:operation => new Promise((resolve, reject) => queueMicrotask(() => {
        try {resolve(request.beforeConnect(operation));} catch (error) {reject(error);}
      }))};
      const pending = native.send(target, mutable);
      mutable.method = changedMethod;
      return pending;
    }};
    const result = await f.sender({adapter})(TARGET, OPTIONS);
    assert.equal(result.status, 200);
    assert.match(f.requests.at(-1).line, /^POST /);
  }
  assert.equal(f.requests.length, 2);
  await f.settled();
});

// This tests the explicit CONNECT core, not the sender's separate deny guard.
test('NO_PROXY entries cannot make explicit native CONNECT use a direct route',async t=>{
 const f=await fixture(t);
 for(const rule of ['*',HOST,'93.184.216.0/24']){
  await f.sender({proxyEnv:{HTTPS_PROXY:f.proxyUrl,NO_PROXY:rule}})(TARGET,OPTIONS);
 }
 assert.equal(f.connects.length,3);assert.equal(f.requests.length,3);assert.deepEqual(f.connects.map(x=>x.authority),Array(3).fill(`${HOST}:443`));await f.settled();
});

for(const [channel,acceptAnyOwnerText] of [['qq',false],['lark',false],['lark',true]])test(`${channel} owner-message experiment${acceptAnyOwnerText?' with ordinary free text':''} completes exactly one native CONNECT/TLS challenge and message`,async t=>{
 const {makeOwnerMessageExperimentTransport}=await import('../experimental/owner-message.js');
 const {makeNodeProxyConnection}=await import('../candidate/node-proxy-connection.js');
 const {signedHeaders}=await import('../index.js');
 const f=await fixture(t,{respond(socket,request){const value=JSON.parse(request.body);const body=JSON.stringify(value.type==='verification'?{challenge:value.challenge}:{});socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);}});
 const now=Date.now(),text='owner native protocol fixture';
 const send=makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel,expectedText:acceptAnyOwnerText?undefined:text,acceptAnyOwnerText,deadlineMs:now+60000,proxyEnv:{HTTPS_PROXY:f.proxyUrl,NO_PROXY:'10.0.0.0/8'},connect:makeNodeProxyConnection({ca:goodIdentity.cert})});t.after(send.close);
 const makeRequest=value=>{const body=Buffer.from(JSON.stringify(value));return {body,headers:signedHeaders({id:'sub_'+'a'.repeat(64),key:Buffer.alloc(32,1)},value.type==='verification'?'verify_'+'b'.repeat(32):value.eventId,body,Date.now()),beforeConnect(){}};};
 await send(TARGET,makeRequest({type:'verification',challenge:'c'.repeat(43)}));
 const event={eventId:'evt_'+'d'.repeat(64),name:`${channel}.message.created`,timestamp:new Date(now).toISOString(),data:{message_id:'native-fixture-message',conversation:'owner',text,reply_deadline:new Date(now+300000).toISOString()},cursor:null};
 await send(TARGET,makeRequest(event));assert.equal(send.state().event_accepted,true);assert.equal(send.preflight().destination_binding,'unverified');
 await assert.rejects(send(TARGET,makeRequest(event)));assert.equal(f.connects.length,2);assert.equal(f.requests.length,2);assert.deepEqual(f.tlsNames,[HOST,HOST]);await f.settled();
});


test('continuous owner sender reuses native forced CONNECT/TLS for multiple authorized events without direct fallback',async t=>{
 const {makeOwnerScopedProxyTransport}=await import('../owner-scoped.js');const {signedHeaders}=await import('../index.js');
 const f=await fixture(t),subscriptionId='sub_'+'a'.repeat(64),expires=Date.now()+60000;
 const sender=makeOwnerScopedProxyTransport({channel:'lark',proxyEnv:{HTTPS_PROXY:f.proxyUrl},connect:makeNodeProxyConnection({ca:goodIdentity.cert})});t.after(sender.close);
 for(let n=1;n<=2;n++){
  const value={eventId:'evt_'+String(n).padStart(64,'0'),name:'lark.message.created',timestamp:new Date().toISOString(),data:{message_id:`fixture-${n}`,conversation:'owner',text:`owner text ${n}`,reply_deadline:new Date(expires).toISOString()},cursor:null},body=Buffer.from(JSON.stringify(value));
  const request={body,headers:signedHeaders({id:subscriptionId,key:Buffer.alloc(32,1)},value.eventId,body,Date.now()),hosts:[HOST],beforeConnect:()=>({principal:'tunnel-owner:dot-bridge',url:TARGET,subscription_id:subscriptionId,expires,verified:true})};
  assert.equal((await sender(TARGET,request)).status,200);await assert.rejects(sender(TARGET,request),e=>e.code==='event_replayed');
 }
 await f.settled();assert.equal(f.connects.length,2);assert.equal(f.requests.length,2);assert.ok(f.tlsNames.every(name=>name===HOST));assert.equal(sender.preflight().destination_binding,'unverified');
});

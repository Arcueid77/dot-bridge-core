// Extracted shared-core regressions. All DNS, HTTPS and managed operations are
// injected; no publisher, listener, task, real network or credential-file access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createHmac } from 'node:crypto';
import {
  validateCallbackUrl, publicAddress, decodeWebhookKey, signedHeaders,
  makeCallbackTransport, CallbackTransportError, preflightCallbackTransport,
} from '../index.js';

import {configuredProxy,bypassMatches} from '../transport.js';

const URL = 'https://callbacks.example.test/events?fixture=synthetic';
const KEY = Buffer.alloc(32, 0x5a); // fixed test bytes, never a runtime credential
const BODY = Buffer.from('{"synthetic":true}');
const HEADERS = signedHeaders({ id: 'sub_fixture', key: KEY }, 'evt_fixture', BODY, 1700000000123);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rejectsCode = (promise, code) => assert.rejects(promise, caught => {
  assert.ok(caught instanceof CallbackTransportError);
  assert.equal(caught.code, code);
  assert.equal(caught.cause, undefined);
  return true;
});

function fixture(options = {}) {
  const calls = { dns: [], requests: [], responses: [], gates: 0, events: [] };
  const lookup = options.lookup || (async (hostname, opts) => {
    calls.dns.push([hostname, opts]);
    calls.events.push('dns');
    return options.answers || [{ address: '93.184.216.34', family: 4 }];
  });
  const request = (url, opts, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.closed = false;
    req.destroy = () => {
      if (req.destroyed) return;
      req.destroyed = true;
      queueMicrotask(() => { req.closed = true; req.emit('close'); });
    };
    req.end = body => {
      req.endedBody = Buffer.from(body);
      calls.events.push('end');
      if (options.requestError) { queueMicrotask(() => req.emit('error', options.requestError)); return; }
      queueMicrotask(() => {
        if (req.destroyed) return;
        const res = new EventEmitter();
        const responseBody = options.body ?? Buffer.from('{"ok":true}');
        res.statusCode = options.status ?? 200;
        res.headers = options.headers || { 'content-type': 'application/json', 'content-length': String(responseBody.length) };
        res.rawHeaders = options.rawHeaders || Object.entries(res.headers).flat();
        res.complete = false;
        res.destroyed = false;
        res.closed = false;
        res.destroy = () => {
          if (res.destroyed) return;
          res.destroyed = true;
          queueMicrotask(() => { res.closed = true; res.emit('close'); });
        };
        calls.responses.push(res);
        callback(res);
        options.onResponse?.(res, req);
        if (options.hang || res.destroyed) return;
        for (const chunk of options.chunks || [responseBody]) {
          if (!res.destroyed) res.emit('data', chunk);
        }
        if (res.destroyed) return;
        res.complete = options.complete ?? true;
        res.emit('end');
        res.closed = true;
        res.emit('close');
        req.closed = true;
        req.emit('close');
      });
    };
    calls.events.push('request');
    calls.requests.push({ url, options: opts, req });
    options.onRequest?.(url, opts, req);
    return req;
  };
  const beforeConnect = () => {
    calls.gates += 1;
    calls.events.push(`gate:${calls.gates}`);
    return options.gate?.(calls.gates);
  };
  const send = makeCallbackTransport({ lookup, request, timeoutMs: options.timeoutMs ?? 100, maxBytes: options.maxBytes ?? 8192,
    maxRequestBytes: 8192, proxyEnv: options.proxyEnv ?? {}, managedAdapter: options.managedAdapter });
  return { calls, send, beforeConnect, run: extra => send(URL, { hosts: ['callbacks.example.test'], headers: HEADERS, body: BODY, beforeConnect, ...extra }) };
}

test('callback URL validation accepts HTTPS DNS and rejects ambiguous or non-public forms before network', () => {
  assert.equal(validateCallbackUrl(URL).hostname, 'callbacks.example.test');
  assert.equal(validateCallbackUrl('https://Example.COM:443/').href, 'https://example.com/');
  const invalid = [
    undefined, null, 123, {}, '', 'http://example.com', 'https:example.com',
    'https://localhost/a', 'https://localhost.', 'https://example.com.',
    'https://127.0.0.1', 'https://2130706433', 'https://0177.0.0.1', 'https://0x7f000001',
    'https://[::1]', 'https://[2606:4700:4700::1111]', 'https://example.com:444',
    'https://example.com:0443', 'https://example.com:', 'https://u:p@example.com',
    'https://@example.com', 'https://example.com/#', 'https://example.com/#fragment',
    ' https://example.com', 'https://example.com\n', 'https://example.com\\@other.example',
    'https://bad_name.example', 'https://example.123', `https://${'a'.repeat(64)}.example`,
    `https://example.com/${'x'.repeat(2048)}`,
  ];
  for (const value of invalid) assert.throws(() => validateCallbackUrl(value), caught => caught.code === 'invalid_url', String(value));
});

test('publicAddress conservatively rejects special-use IPv4 and IPv6 ranges', () => {
  const publicValues = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1',
    '172.15.255.255', '172.32.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1',
    '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001::1', '2001:0200::1'];
  const blockedValues = [undefined, null, 123, '', 'garbage', '01.2.3.4', '1.2.3.256',
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '127.0.0.1', '127.255.255.255',
    '100.64.0.0', '100.127.255.255', '169.254.1.1', '172.16.0.0', '172.31.255.255',
    '192.0.0.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.0', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:808:808',
    '64:ff9b::808:808', '64:ff9b:1::1', '100::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2001:1ff::1',
    '2001:db8::1', '2001:0DB8:0:0:0:0:0:1', '2002:808:808::1', '3fff::1', '3fff:fff::1', '5f00::1'];
  for (const value of publicValues) assert.equal(publicAddress(value), true, value);
  for (const value of blockedValues) assert.equal(publicAddress(value), false, String(value));
});

test('webhook key accepts canonical padded/unpadded 24–64 bytes and rejects malformed encodings', () => {
  for (const size of [24, 25, 31, 32, 33, 63, 64]) {
    const bytes = Buffer.alloc(size, 0x5a), b64 = bytes.toString('base64');
    assert.deepEqual(decodeWebhookKey(`whsec_${b64}`), bytes);
    assert.deepEqual(decodeWebhookKey(`whsec_${b64.replace(/=+$/, '')}`), bytes);
  }
  for (const value of [null, KEY, '', `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`,
    `whsec_${KEY.toString('base64')}=`, `whsec_${KEY.toString('base64').replace(/o=$/, 'p=')}`, 'whsec_A===',
    `whsec_${KEY.toString('base64')}\n`, `other_${KEY.toString('base64')}`]) {
    assert.throws(() => decodeWebhookKey(value), caught => caught.code === 'invalid_key');
  }
});

test('signedHeaders matches independent Standard Webhooks HMAC over exact bytes', () => {
  const payload = Buffer.from('{"data":"合成"}');
  const headers = signedHeaders({ id: 'sub-test', key: KEY }, 'evt:test', payload, 1700000000999);
  assert.equal(headers['webhook-timestamp'], '1700000000');
  assert.equal(headers['webhook-signature'], `v1,${createHmac('sha256', KEY).update(Buffer.concat([Buffer.from('evt:test.1700000000.'), payload])).digest('base64')}`);
  assert.equal(headers['x-mcp-subscription-id'], 'sub-test');
  assert.equal(headers['content-type'], 'application/json');
  assert.throws(() => signedHeaders({ id: 'sub\r\nbad', key: KEY }, 'evt', payload, 1700000000000));
  assert.throws(() => signedHeaders({ id: 'sub', key: KEY }, 'evt\r\nbad', payload, 1700000000000));
  assert.throws(() => signedHeaders({ id: 'sub', key: `whsec_${KEY.toString('base64')}` }, 'evt', payload, 1700000000000));
  for (const now of [NaN, Infinity, -1, 1.5, '1700000000000']) assert.throws(() => signedHeaders({ id: 'sub', key: KEY }, 'evt', payload, now));
});

test('sender pins one vetted address, preserves URL Host and TLS identity, and bypasses global agents', async () => {
  const answers = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  const f = fixture({ answers, gate: count => { if (count === 3) answers[0].address = '127.0.0.1'; } });
  const controller = new AbortController();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), '{"ok":true}');
  assert.deepEqual(f.calls.dns, [['callbacks.example.test', { all: true, verbatim: true }]]);
  assert.deepEqual(f.calls.events, ['gate:1', 'dns', 'gate:2', 'gate:3', 'request', 'gate:4', 'end', 'gate:5']);
  assert.equal(f.calls.requests.length, 1);
  const { url, options, req } = f.calls.requests[0];
  assert.equal(url.href, URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.agent, false);
  assert.equal(options.family, 4);
  assert.equal(options.autoSelectFamily, false);
  assert.equal(options.servername, url.hostname);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.host, url.hostname);
  assert.equal(options.headers['accept-encoding'], 'identity');
  assert.equal(options.headers['content-length'], String(BODY.length));
  assert.equal(options.maxHeaderSize, 8192);
  assert.equal(options.insecureHTTPParser, false);
  assert.equal(options.joinDuplicateHeaders, false);
  assert.equal(options.createConnection, undefined);
  assert.equal(options.proxy, undefined);
  assert.equal(req.maxHeadersCount, 32);
  assert.deepEqual(req.endedBody, BODY);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await tick();
  for (const emitter of [req, ...f.calls.responses]) assert.equal(emitter.eventNames().length, 0);
});

test('pinned lookup supplies fresh copies, rejects host substitution, and never repeats DNS', async () => {
  const f = fixture({ onRequest: (url, opts) => {
    opts.lookup(url.hostname, { all: true }, (err, answers) => {
      assert.equal(err, null);
      assert.deepEqual(answers, [{ address: '93.184.216.34', family: 4 }]);
      answers[0].address = '127.0.0.1';
    });
    opts.lookup(url.hostname, {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    opts.lookup(url.hostname, (err, address, family) => { assert.equal(err, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    opts.lookup('other.example.test', {}, err => assert.equal(err.code, 'connection_failed'));
  } });
  await f.run();
  assert.equal(f.calls.dns.length, 1);
});

test('IPv6 pin retains original DNS TLS hostname', async () => {
  const f = fixture({ answers: [{ address: '2606:4700:4700::1111', family: 6 }], onRequest: (url, opts) => {
    assert.equal(opts.family, 6);
    assert.equal(opts.servername, 'callbacks.example.test');
    opts.lookup(url.hostname, {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, '2606:4700:4700::1111'); assert.equal(family, 6); });
  } });
  await f.run();
});

test('any invalid, non-public or mismatched DNS answer prevents connection', async () => {
  for (const answers of [[], null, {}, Array(33).fill({ address: '8.8.8.8', family: 4 }),
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }], [{ address: '2606:4700:4700::1111', family: 4 }],
    [{ address: '93.184.216.34', family: '4' }], [{ address: 'invalid', family: 4 }], [null]]) {
    const f = fixture({ lookup: async () => answers });
    await rejectsCode(f.run(), 'blocked_address');
    assert.equal(f.calls.requests.length, 0);
  }
});

test('every send repeats all-answer DNS validation, with no cached trust', async () => {
  let count = 0;
  const f = fixture({ lookup: async () => [{ address: ++count === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }] });
  await f.run();
  await rejectsCode(f.run(), 'blocked_address');
  assert.equal(count, 2);
  assert.equal(f.calls.requests.length, 1);
});

test('permission gate failures before DNS, after DNS, before connect and before end are fail-closed', async () => {
  for (const gate of [1, 2, 3, 4]) {
    const f = fixture({ gate: count => { if (count === gate) throw new Error('private callback and credential must never surface'); } });
    await rejectsCode(f.run(), 'gate_failed');
    assert.equal(f.calls.dns.length, gate === 1 ? 0 : 1);
    assert.equal(f.calls.requests.length, gate === 4 ? 1 : 0);
    if (gate === 4) { assert.equal(f.calls.requests[0].req.destroyed, true); assert.equal(f.calls.requests[0].req.endedBody, undefined); }
  }
});

test('a pre-aborted signal causes no DNS and removes its listener', async () => {
  const controller = new AbortController(); controller.abort(new Error('private reason'));
  const f = fixture();
  await rejectsCode(f.run({ signal: controller.signal }), 'aborted');
  assert.equal(f.calls.dns.length, 0);
  assert.equal(f.calls.requests.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort cancels DNS wait and a late answer cannot connect', async () => {
  const dns = deferred(), started = deferred(), controller = new AbortController();
  const f = fixture({ lookup: () => { started.resolve(); return dns.promise; } });
  const sending = f.run({ signal: controller.signal });
  await started.promise;
  controller.abort();
  await rejectsCode(sending, 'aborted');
  dns.resolve([{ address: '8.8.8.8', family: 4 }]);
  await tick();
  assert.equal(f.calls.requests.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort while async pre-end gate waits destroys the request without sending its body', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController();
  const f = fixture({ gate: count => { if (count === 4) { started.resolve(); return gate.promise; } } });
  const sending = f.run({ signal: controller.signal });
  await started.promise;
  controller.abort();
  await rejectsCode(sending, 'aborted');
  gate.resolve();
  await tick();
  assert.equal(f.calls.requests[0].req.endedBody, undefined);
  assert.equal(f.calls.requests[0].req.destroyed, true);
  assert.equal(f.calls.requests[0].req.eventNames().length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort after response starts destroys both streams and cleans listeners', async () => {
  const started = deferred(), controller = new AbortController();
  const f = fixture({ hang: true, onResponse: () => started.resolve() });
  const sending = f.run({ signal: controller.signal });
  await started.promise;
  controller.abort();
  await rejectsCode(sending, 'aborted');
  await tick();
  assert.equal(f.calls.responses[0].destroyed, true);
  assert.equal(f.calls.requests[0].req.destroyed, true);
  for (const emitter of [f.calls.requests[0].req, ...f.calls.responses]) assert.equal(emitter.eventNames().length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('single overall deadline bounds DNS, async gates and HTTP, without retries', async () => {
  for (const extra of [{ lookup: () => new Promise(() => {}) }, { gate: () => new Promise(() => {}) }, { hang: true }]) {
    const controller = new AbortController();
    const f = fixture({ timeoutMs: 10, ...extra });
    await rejectsCode(f.run({ signal: controller.signal }), 'timeout');
    assert.ok(f.calls.requests.length <= 1);
    if (f.calls.requests.length) assert.equal(f.calls.requests[0].req.destroyed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('redirects and malformed statuses are rejected without a followup request', async () => {
  for (const status of [100, 199, 300, 301, 302, 303, 307, 308, 399, 600, '200', undefined]) {
    const f = fixture({ status: status === undefined ? NaN : status });
    await rejectsCode(f.run(), Number.isInteger(status) && status >= 300 && status <= 399 ? 'redirect_rejected' : 'invalid_response');
    assert.equal(f.calls.requests.length, 1);
  }
});

test('bounded non-2xx responses reach the application without transport retries', async () => {
  for (const status of [400, 410, 429, 500, 599]) {
    const f = fixture({ status });
    const response = await f.run();
    assert.equal(response.status, status);
    assert.ok(Buffer.isBuffer(response.body));
    assert.equal(f.calls.requests.length, 1);
  }
});

test('compressed, duplicate, inconsistent, oversized or ambiguous response headers fail closed', async () => {
  const cases = [
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-encoding': 'br' } },
    { headers: { 'transfer-encoding': 'gzip, chunked' } },
    { headers: { 'transfer-encoding': 'chunked', 'content-length': '11' } },
    { headers: { 'content-length': '8193' } }, { headers: { 'content-length': '+11' } },
    { headers: { 'content-length': '011' } }, { headers: { 'content-length': '-1' } },
    { headers: { 'content-length': '11' }, rawHeaders: ['Content-Length', '10'] },
    { headers: { 'content-length': '11' }, rawHeaders: ['Content-Length', '11', 'Content-Length', '11'] },
    { headers: {}, rawHeaders: ['Content-Type'] },
    { headers: { 'content-type': 'a\r\nb' } },
    { headers: { 'x-big': 'a'.repeat(8192) } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, 'x'])) },
    { headers: { 'Content-Type': 'application/json' }, rawHeaders: ['Content-Type', 'application/json'] },
  ];
  for (const entry of cases) {
    const f = fixture(entry);
    await rejectsCode(f.run(), 'invalid_response');
    assert.equal(f.calls.requests.length, 1);
  }
});

test('benign repeated response headers are bounded and discarded, not forwarded', async () => {
  const result = await fixture({ headers: { 'set-cookie': ['fixture=a', 'fixture=b'], server: 'fixture', 'content-length': '11' },
    rawHeaders: ['Set-Cookie', 'fixture=a', 'Set-Cookie', 'fixture=b', 'Server', 'fixture', 'Server', 'ignored', 'Content-Length', '11'] }).run();
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.headers), ['content-length']);
  assert.equal(result.headers['set-cookie'], undefined);
});

test('body limits, exact Content-Length, binary chunks and completeness are enforced', async () => {
  for (const entry of [
    { body: Buffer.alloc(8193), headers: {} },
    { chunks: [Buffer.alloc(4000), Buffer.alloc(4193)], headers: {} },
    { maxBytes: 4, body: Buffer.alloc(5), headers: {} },
  ]) await rejectsCode(fixture(entry).run(), 'response_too_large');
  for (const entry of [
    { body: Buffer.from('abc'), headers: { 'content-length': '2' } },
    { body: Buffer.from('abc'), headers: { 'content-length': '4' } },
    { chunks: ['string rather than raw bytes'], headers: {} },
    { complete: false },
  ]) await rejectsCode(fixture(entry).run(), 'invalid_response');
  const result = await fixture({ body: Buffer.alloc(8192), headers: { 'content-encoding': 'identity', 'transfer-encoding': 'chunked' } }).run();
  assert.equal(result.body.length, 8192);
});

test('request input forbids arbitrary routing/auth headers, duplicates, oversized bodies and implicit approval', async () => {
  const f = fixture();
  for (const headers of [null, [], { Host: 'other.example.test' }, { authorization: 'secret' }, { cookie: 'secret' },
    { 'content-type': 'application/json', 'Content-Type': 'application/json' },
    { 'content-type': 'text/plain' }, { 'webhook-id': 'evt\r\nHost: evil.test' }, { 'webhook-id': 'a'.repeat(1025) }]) {
    await rejectsCode(f.run({ headers }), 'invalid_input');
  }
  await rejectsCode(f.run({ body: Buffer.alloc(8193) }), 'invalid_input');
  await rejectsCode(f.run({ body: {} }), 'invalid_input');
  await rejectsCode(f.run({ beforeConnect: undefined }), 'invalid_input');
  await rejectsCode(f.run({ signal: {} }), 'invalid_input');
  assert.equal(f.calls.dns.length, 0);
  assert.equal(f.calls.requests.length, 0);
});

test('DNS, TLS and request failures expose no raw error, destination or credentials', async () => {
  const secretError = Object.assign(new Error('PRIVATE_HOST PRIVATE_BODY PRIVATE_KEY'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  for (const [extra, code] of [[{ lookup: async () => { throw secretError; } }, 'dns_failed'], [{ requestError: secretError }, 'tls_failed']]) {
    const f = fixture(extra);
    await assert.rejects(f.run(), caught => {
      assert.ok(caught instanceof CallbackTransportError);
      assert.equal(caught.code, code);
      assert.equal(caught.reason, code);
      assert.doesNotMatch(String(caught), /PRIVATE_|example\.test|ERR_TLS/);
      assert.equal(caught.cause, undefined);
      assert.doesNotMatch(JSON.stringify(caught), /PRIVATE_|example\.test/);
      return true;
    });
  }
});

test('permission revocation after the response prevents reporting success', async () => {
  const f = fixture({ gate: count => { if (count === 5) throw new Error('revoked'); } });
  await rejectsCode(f.run(), 'gate_failed');
  assert.equal(f.calls.requests.length, 1);
});

test('synchronous authority gates share a stack with DNS and connection, without an expiry microtask gap', async () => {
  let expired = false;
  const f = fixture({ gate: count => {
    if (expired) throw new Error('lease expired');
    if (count === 3) queueMicrotask(() => { expired = true; });
  }, onRequest: () => assert.equal(expired, false) });
  await rejectsCode(f.run(), 'gate_failed');
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.requests[0].req.endedBody, undefined);
  let dnsExpired = false;
  const dns = fixture({ gate: () => {
    if (dnsExpired) throw new Error('lease expired');
    queueMicrotask(() => { dnsExpired = true; });
  }, lookup: async () => { assert.equal(dnsExpired, false); return [{ address: '8.8.8.8', family: 4 }]; } });
  await rejectsCode(dns.run(), 'gate_failed');
  assert.equal(dns.calls.requests.length, 0);
});

// Adapter tests use only code-injected fake operations. No proxy socket or
// CONNECT implementation exists in the shared package.
test('configured proxies construct blocked and refuse sending before fake DNS or requests', async () => {
  for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const f = fixture({ proxyEnv: { [variable]: 'http://proxy.example.test:3128', CALLBACK_PROXY_VERIFIED: 'true' } });
    const reason = ['HTTPS_PROXY', 'https_proxy'].includes(variable) ? 'proxy_policy_unverified' : 'proxy_unsupported';
    assert.deepEqual(f.send.preflight(), {
      ready: false, mode: 'blocked', reason, proxy_configured: true,
      destination_binding: 'unverified', network_checked: false,
    });
    await rejectsCode(f.run(), reason);
    assert.equal(f.calls.dns.length, 0);
    assert.equal(f.calls.requests.length, 0);
  }
});

test('managed injection stays blocked and never transmits target or proxy credentials', async () => {
  let adapterCalls=0;
  const f=fixture({proxyEnv:{HTTPS_PROXY:'http://fixture-user:fixture-secret@proxy.example.test:3128'},managedAdapter:{send:async()=>{adapterCalls++;return {status:200,headers:{},body:Buffer.from('{}')};}}});
  assert.deepEqual(f.send.preflight(),{ready:false,mode:'blocked',reason:'proxy_policy_unverified',proxy_configured:true,destination_binding:'unverified',network_checked:false});
  await rejectsCode(f.run(),'proxy_policy_unverified');
  assert.equal(f.calls.dns.length,0);assert.equal(f.calls.requests.length,0);assert.equal(adapterCalls,0);
  assert.doesNotMatch(JSON.stringify(f.send.preflight()),/fixture-user|fixture-secret|proxy\.example/);
});

test('neither public nor private local DNS answers can make an unverified proxy usable', async () => {
  for(const answers of [[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4}]]){
    let invoked=0;const f=fixture({answers,proxyEnv:{HTTPS_PROXY:'http://proxy.example.test:3128'},managedAdapter:{async send(){invoked++;throw Error('PRIVATE_SECRET');}}});
    await rejectsCode(f.run(),'proxy_policy_unverified');assert.equal(invoked,0);assert.equal(f.calls.dns.length,0);assert.equal(f.calls.requests.length,0);
  }
});

test('adding proxy configuration after construction refuses before DNS', async () => {
  const proxyEnv = {}, f = fixture({ proxyEnv });
  proxyEnv.HTTPS_PROXY = 'http://proxy.example.test:3128';
  await rejectsCode(f.run(), 'proxy_policy_unverified');
  assert.equal(f.calls.dns.length, 0);
  assert.equal(f.calls.requests.length, 0);
});

test('lowercase-first HTTPS proxy selection ignores unselected settings', () => {
  assert.deepEqual(preflightCallbackTransport({ proxyEnv: { https_proxy: 'http://selected.example.test:3128', HTTPS_PROXY: 'invalid-upper',
    HTTP_PROXY: 'invalid-http', http_proxy: 42, ALL_PROXY: 'socks5://unused.example.test/non-root', all_proxy: 'not-a-url' } }),
  { ready: false, mode: 'blocked', reason: 'proxy_policy_unverified', proxy_configured: true,
    destination_binding: 'unverified', network_checked: false });
  for (const invalid of ['invalid', 'socks5://bad.example.test/path', 42]) {
    assert.equal(preflightCallbackTransport({ proxyEnv: { https_proxy: invalid, HTTPS_PROXY: 'http://valid.example.test:3128' } }).reason, 'proxy_unsupported');
  }
});

test('multiple public candidates never trigger address/family fallback or DNS retry after a direct TLS failure', async () => {
  const candidates = [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  let pinnedCalls = 0;
  const f = fixture({ answers: candidates, requestError: Object.assign(new Error('synthetic TLS mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), onRequest: (url, options) => {
    assert.equal(options.autoSelectFamily, false); assert.equal(options.family, 4); assert.equal(options.rejectUnauthorized, true);
    options.lookup(url.hostname, { all: true }, (caught, addresses) => { assert.equal(caught, null); pinnedCalls++; assert.deepEqual(addresses, [candidates[0]]); });
  } });
  await rejectsCode(f.run(), 'tls_failed'); await tick();
  assert.equal(pinnedCalls, 1); assert.equal(f.calls.dns.length, 1); assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.requests[0].req.destroyed, true);
});

test('simulated later DNS changes in an unselected answer are rejected before a new connection', async () => {
  let lookups = 0;
  const f = fixture({ lookup: async () => {
    lookups++;
    return [{ address: '93.184.216.34', family: 4 }, { address: lookups === 1 ? '1.1.1.1' : '10.0.0.1', family: 4 }];
  } });
  await f.run(); await rejectsCode(f.run(), 'blocked_address'); await tick();
  assert.equal(lookups, 2); assert.equal(f.calls.requests.length, 1);
});

test('outbound socket peer metadata is never consumed as destination or TLS proof', async () => {
  let peerReads = 0;
  const peer = () => Object.defineProperty({}, 'remoteAddress', { get() { peerReads++; throw new Error('Adjacent peer is not final-destination proof'); } });
  const f = fixture({ onRequest: (_url, _options, request) => { request.socket = peer(); }, onResponse: response => { response.socket = peer(); } });
  await f.run(); assert.equal(peerReads, 0);
});

// NO_PROXY is a conservative deny policy here: a match never selects a direct
// route. CIDR support is our explicit parser contract, not a Node proxy claim.
function proxyFixture(rule, answers, env = {}) {
  let delegated = 0;
  const f = fixture({ answers,
    proxyEnv: { HTTPS_PROXY: 'http://proxy.example.test:3128', no_proxy: rule, ...env },
    managedAdapter: { async send(_target, request) {
      return request.beforeConnect(() => {
        delegated++;
        return { status: 200, headers: {}, body: Buffer.from('{}') };
      });
    } }
  });
  return { ...f, delegated: () => delegated };
}

test('NO_PROXY exact host, suffix and wildcard matches deny before DNS without direct fallback', async () => {
  for (const rule of ['callbacks.example.test', 'CALLBACKS.EXAMPLE.TEST:443', '.example.test', '*.example.test', '*']) {
    const f = proxyFixture(rule);
    assert.equal(bypassMatches(configuredProxy({HTTPS_PROXY:'http://proxy.example.test',no_proxy:rule}),'callbacks.example.test'),true);
    await rejectsCode(f.run(), 'proxy_policy_unverified');
    assert.equal(f.calls.dns.length, 0);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.delegated(), 0);
  }
  for (const rule of ['example.test', '.other.example.test', 'notcallbacks.example.test']) {
    const f = proxyFixture(rule);
    assert.equal(bypassMatches(configuredProxy({HTTPS_PROXY:'http://proxy.example.test',no_proxy:rule}),'callbacks.example.test'),false);
    await rejectsCode(f.run(),'proxy_policy_unverified');
    assert.equal(f.calls.dns.length, 0);
    assert.equal(f.delegated(), 0);
    assert.equal(f.calls.requests.length, 0);
  }
});

test('NO_PROXY lower-first selection ignores an invalid unselected value but rejects an invalid selected value', async () => {
  const f = proxyFixture('10.0.0.0/8', undefined, { NO_PROXY: 'invalid/unused' });
  await rejectsCode(f.run(),'proxy_policy_unverified'); assert.equal(f.delegated(), 0);
  const invalid = proxyFixture('bad/24', undefined, { NO_PROXY: '10.0.0.0/8' });
  assert.equal(invalid.send.preflight().reason, 'proxy_unsupported');
  await rejectsCode(invalid.run(), 'proxy_unsupported');
  assert.equal(invalid.calls.dns.length, 0); assert.equal(invalid.delegated(), 0);
  for (const lower of [undefined, '']) {
    const fallback = proxyFixture(lower, undefined, { NO_PROXY: 'callbacks.example.test' });
    await rejectsCode(fallback.run(), 'proxy_policy_unverified');
    assert.equal(fallback.calls.dns.length, 0); assert.equal(fallback.delegated(), 0);
  }
});

test('NO_PROXY IPv4 CIDR zero/full prefixes, host bits and subnet boundaries are strict denies', async () => {
  const cases = [
    ['0.0.0.0/0', '93.184.216.34', true],
    ['93.184.216.34/32', '93.184.216.34', true],
    ['93.184.216.35/32', '93.184.216.34', false],
    ['93.184.216.199/24', '93.184.216.0', true],
    ['93.184.216.0/24', '93.184.216.255', true],
    ['93.184.216.0/24', '93.184.215.255', false],
    ['93.184.216.0/24', '93.184.217.0', false],
    ['93.184.216.34/31', '93.184.216.35', true],
    ['93.184.216.34/31', '93.184.216.36', false],
    ['::/0', '93.184.216.34', false]
  ];
  for (const [rule, address, denied] of cases) {
    const f = proxyFixture(rule, [{ address, family: 4 }]);
    assert.equal(bypassMatches(configuredProxy({HTTPS_PROXY:'http://proxy.example.test',no_proxy:rule}),'callbacks.example.test',[address]),denied,rule);
    await rejectsCode(f.run(),'proxy_policy_unverified');
    assert.equal(f.calls.dns.length, 0, rule);
    assert.equal(f.delegated(), 0, rule);
    assert.equal(f.calls.requests.length, 0, rule);
  }
});

test('NO_PROXY IPv6 CIDR zero/full prefixes and non-byte-aligned boundaries preserve address family', async () => {
  const cases = [
    ['::/0', '2606:4700:4700::1111', true],
    ['2606:4700:4700::1111/128', '2606:4700:4700:0:0:0:0:1111', true],
    ['2606:4700:4700::1110/128', '2606:4700:4700::1111', false],
    ['2606:4700:ffff::/32', '2606:4700::1', true],
    ['2606:4700::/32', '2606:4701::1', false],
    ['2606:4700::/33', '2606:4700:7fff:ffff::1', true],
    ['2606:4700::/33', '2606:4700:8000::1', false],
    ['0.0.0.0/0', '2606:4700:4700::1111', false]
  ];
  for (const [rule, address, denied] of cases) {
    const f = proxyFixture(rule, [{ address, family: 6 }]);
    assert.equal(bypassMatches(configuredProxy({HTTPS_PROXY:'http://proxy.example.test',no_proxy:rule}),'callbacks.example.test',[address]),denied,rule);
    await rejectsCode(f.run(),'proxy_policy_unverified');
    assert.equal(f.calls.dns.length, 0, rule);
    assert.equal(f.delegated(), 0, rule);
    assert.equal(f.calls.requests.length, 0, rule);
  }
});

test('NO_PROXY checks every vetted address, including an unselected IPv4 or IPv6 candidate', async () => {
  const answers = [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  for (const rule of ['1.1.1.1', '1.1.1.0/24', '2606:4700::/32', '[2606:4700:4700::1111]:443', '2606:4700:4700::1111']) {
    const f = proxyFixture(rule, answers);
    assert.equal(bypassMatches(configuredProxy({HTTPS_PROXY:'http://proxy.example.test',no_proxy:rule}),'callbacks.example.test',answers.map(a=>a.address)),true);
    await rejectsCode(f.run(), 'proxy_policy_unverified');
    assert.equal(f.calls.dns.length, 0);
    assert.equal(f.delegated(), 0);
    assert.equal(f.calls.requests.length, 0);
  }
});

test('malformed or excessive NO_PROXY CIDR rules reject before any DNS or delegation', async () => {
  for (const rule of ['10.0.0.0/33', '2606:4700::/129', '10.0.0.0/-1', '10.0.0.0/+8', '10.0.0.0/08',
    '10.0.0.0/1.5', '10.0.0.0/', '10.0.0.0/8/1', '999.0.0.0/8', '[2606:4700::]/32',
    'fe80::1%eth0/64', 'example.test/24', '2606:4700::/001', 42, null,
    Array(65).fill('10.0.0.0/8').join(','), 'x'.repeat(4097)]) {
    const f = proxyFixture(rule);
    assert.equal(f.send.preflight().reason, 'proxy_unsupported');
    await rejectsCode(f.run(), 'proxy_unsupported');
    assert.equal(f.calls.dns.length, 0); assert.equal(f.delegated(), 0);
    assert.equal(f.calls.requests.length, 0);
  }
});

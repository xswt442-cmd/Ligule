// 验证网络地址分类、策略审批、重定向重检、超时和响应字节上限。
// 服务器是真的（本机环回上一个 http.Server），内核与判定链走的是同一条调用路径；
// 只有 DNS 那一步换成一张固定的表——要判的是分类与「连的是批准过的那个地址」，不是运营商今天给哪一个 IP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyAddress, createConfig, createDecisionChain, createKernel, createSessionLog, fetchTarget,
  loadAssembly, minimalPlugin, networkPlugin, resolveTarget,
} from '../dist/index.js';
import { fetchTool } from '../dist/tools/network.js';

const listening = (server: Server) => new Promise<{ origin: string; port: string }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, port: String((server.address() as AddressInfo).port) }));
});
const limits = { maxBytes: 1_000, timeoutMs: 2_000, redirectLimit: 5 };
const fromTable = (table: Record<string, string[]>) => async (host: string) => {
  if (!(host in table)) throw new Error(`unexpected lookup for ${host}`);
  return table[host];
};

test('addresses are classified by their bytes, including the forms a URL normalizes into', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('128.0.0.1'), 'public');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.15.255.255'), 'public');
  assert.equal(classifyAddress('192.168.7.7'), 'private');
  assert.equal(classifyAddress('100.64.0.9'), 'private');
  assert.equal(classifyAddress('100.128.0.1'), 'public');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  // 未指定、组播与保留段不按公网算。
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('224.0.0.1'), 'unspecified');
  assert.equal(classifyAddress('255.255.255.255'), 'unspecified');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::'), 'unspecified');
  assert.equal(classifyAddress('fd12:3456::1'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('ff02::1'), 'unspecified');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
  // 同一条 IPv4 映射地址的两种写法必须给出同一个结果：URL 会把点分那一种规范化成十六进制那一种。
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:7f00:1'), 'loopback');
  assert.equal(classifyAddress('::ffff:9301:d222'), 'public');
  assert.equal(classifyAddress('::1:2:3:4:5'), 'public');
  assert.equal(classifyAddress('gg::1'), 'unspecified');
  assert.equal(classifyAddress('1.2.3'), 'unspecified');
});

test('special-purpose addresses follow IANA reachability instead of being treated as ordinary public IPs', () => {
  for (const address of [
    '192.0.0.8', '192.0.0.11', '192.0.0.170', '192.0.2.1', '192.88.99.1', '198.51.100.1', '203.0.113.1',
    '2001:db8::1', '3fff::1', '100:0:0:1::1',
  ]) {
    assert.equal(classifyAddress(address), 'unspecified', address);
  }
  for (const address of [
    '192.0.0.0', '198.18.0.0', '198.19.255.255', '2001:2::1', '2002::1', '5f00::1', '64:ff9b:1::1',
  ]) {
    assert.equal(classifyAddress(address), 'private', address);
  }
  for (const address of [
    '192.0.0.9', '192.0.0.10', '192.31.196.1', '192.52.193.1', '192.175.48.1',
    '198.20.0.0', '2001:1::1', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:30::1', '2620:4f:8000::1',
  ]) {
    assert.equal(classifyAddress(address), 'public', address);
  }
});

test('IANA non-globally-reachable destinations use the existing ask or deny policy classes', async () => {
  const asked: { reason: string | undefined }[] = [];
  const chain = createDecisionChain({ mode: 'auto', ask: async (question) => (asked.push(question), true) });
  for (const url of ['http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://[2001:db8::1]/']) {
    const target = await resolveTarget(url);
    assert.equal(target.class, 'unspecified', url);
    assert.equal((await chain.evaluate({ tool: 'fetch', input: {}, target })).code, 'policy_denied', url);
  }
  const benchmark = await resolveTarget('http://198.18.0.1/');
  assert.equal(benchmark.class, 'private');
  assert.equal((await chain.evaluate({ tool: 'fetch', input: {}, target: benchmark })).decision, 'allow');
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason as string, /private/u);
});

test('a target is one URL, one resolution, and the strictest address decides', async () => {
  const resolve = fromTable({ 'mix.es': ['93.184.216.34', '10.0.0.5'], 'pu.blic': ['93.184.216.34'], 'bad.host': [] });
  assert.equal((await resolveTarget('http://mix.es/x', { resolve })).class, 'private');
  assert.equal((await resolveTarget('https://pu.blic/', { resolve })).class, 'public');
  assert.equal((await resolveTarget('http://bad.host/', { resolve })).failure, 'unresolved');
  assert.equal((await resolveTarget('file:///etc/passwd')).failure, 'unsupported');
  assert.equal((await resolveTarget('http://user:pw@host/')).failure, 'unsupported');
  assert.equal((await resolveTarget('')).failure, 'unsupported');
  assert.equal((await resolveTarget('not a url')).failure, 'unsupported');
  // 字面量地址不经 DNS；带方括号的那种被 URL 规范化之后仍按 IPv4 映射判。
  assert.equal((await resolveTarget('http://localhost:5368/')).class, 'loopback');
  assert.equal((await resolveTarget('http://[::ffff:127.0.0.1]:8080/x')).class, 'loopback');
  assert.deepEqual((await resolveTarget('http://10.0.0.7/x')).addresses, ['10.0.0.7']);
});

test('the chain tightens on the class before any rule is consulted', async () => {
  const asked: { reason: string | undefined }[] = [];
  const chain = (answer: boolean) => createDecisionChain({
    mode: 'auto',
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    rules: [{ tool: 'fetch', decision: 'allow' }],
  });

  // 自动档也不把环回与内网直接放行：那条 URL 指的是本机上的服务，规则表写得再宽也不算盖住。
  const loop = await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://127.0.0.1:8080/') });
  assert.deepEqual(loop, { decision: 'allow', capability: 'fetch', via: 'ask', level: 'auto', answer: 'allow' });
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason as string, /loopback/);
  assert.equal((await chain(false).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://10.0.0.5/x') })).code, 'ask_declined');

  // 链路本地与「根本不该被取回的地址」不进询问：没有可问的余地。
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[ff02::1]/', 'http://0.0.0.0/']) {
    const before: number = asked.length;
    const denied = await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget(url) });
    assert.equal(denied.code, 'policy_denied', url);
    assert.equal(asked.length, before, `${url} did not ask`);
  }
  assert.equal((await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('ftp://host/x') })).code, 'policy_denied');
  // 公网目标在自动档里照原来的顺序走：这一件工具没有命令文本可解析。
  assert.deepEqual(await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://93.184.216.34/') }), { decision: 'allow', capability: 'fetch', via: 'auto', level: 'auto' });
});

test('the socket uses the address the target resolved to while the name stays in the request', async () => {
  const seen: { host: string | undefined; url: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('the page');
  });
  const { port } = await listening(server);
  const looked: string[] = [];
  const resolve = async (host: string) => {
    looked.push(host);
    return ['127.0.0.1'];
  };
  try {
    // 名字指向环回：批准是对这一个 IP 给的，连接也就不再去问第二次 DNS。
    const target = await resolveTarget(`http://approved.invalid:${port}/note`, { resolve });
    const page = await fetchTarget(target, { ...limits, resolve });
    assert.equal(page.text, 'the page');
    assert.deepEqual(seen, [{ host: `approved.invalid:${port}`, url: '/note' }]);
    assert.deepEqual(looked, ['approved.invalid'], 'one resolution for one request');
    assert.equal(target.class, 'loopback');
  } finally {
    server.close();
  }
});

test('fetch is asked about a loopback page and records what arrived', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.url === '/big' ? 'x'.repeat(5_000) : 'the page');
  });
  const { origin } = await listening(server);
  const asked: { reason: string | undefined }[] = [];
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd(), limits: { fetchBytes: 1_000 } } }),
    policy: createDecisionChain({ mode: 'auto', ask: async (question) => (asked.push(question), true) }),
  });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  try {
    const result = await kernel.call('fetch', { url: `${origin}/note` }) as { text: string; host: string; targetClass: string; bytes: number; hops: number; truncated: boolean };
    assert.equal(result.text, 'the page');
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.targetClass, 'loopback');
    assert.equal(result.bytes, 8);
    assert.equal(result.hops, 0);
    assert.equal(asked.length, 1, 'the loopback target was asked about even in the automatic level');
    assert.match(asked[0].reason as string, /loopback/);

    const capped = await kernel.call('fetch', { url: `${origin}/big` }) as { text: string; bytes: number; truncated: boolean };
    assert.ok(capped.text.startsWith('x'.repeat(1_000)));
    assert.match(capped.text, /\[truncated: 1000 of 5000 bytes shown]/);
    assert.equal(capped.bytes, 5_000);
    assert.equal(capped.truncated, true);

    // 判定链在的话根本不会问到工具这里；没有链的那一条入口（`ligule call`）由工具自己守住这条边界。
    const metadata = await kernel.call('fetch', { url: 'http://169.254.169.254/latest/meta-data/' }).catch((error) => error) as { code: string };
    assert.equal(metadata.code, 'policy_denied');
    assert.equal(asked.length, 2, 'the denial did not add a question');
    const chainless = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
    loadAssembly(chainless, [minimalPlugin, networkPlugin]);
    const refused = await chainless.call('fetch', { url: 'http://169.254.169.254/latest/meta-data/' }).catch((error) => error) as { code: string };
    assert.equal(refused.code, 'fetch_target_denied');
  } finally {
    server.close();
  }
});

test('a redirect must be the same origin and the same class, re-resolved', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/same-origin') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    if (request.url === '/final') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('landed');
      return;
    }
    if (request.url === '/cross-origin') {
      response.writeHead(302, { location: 'http://example.com:1/final' });
      response.end();
      return;
    }
    if (request.url === '/rebinds') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end('nope');
  });
  const { origin, port } = await listening(server);
  try {
    const same = await fetchTarget(await resolveTarget(`${origin}/same-origin`), limits);
    assert.equal(same.text, 'landed');
    assert.equal(same.hops, 1);

    // 换了主机就不是那一次批准覆盖的目标：同源之内才继续跟。
    const cross = await fetchTarget(await resolveTarget(`${origin}/cross-origin`), limits).catch((error) => error) as { code: string; detail: string };
    assert.equal(cross.code, 'fetch_redirect_denied');
    assert.match(cross.detail, /another origin/);

    // 同一个名字，第二跳解析到别的类别也算换了目标：每一跳都重新解析一次。
    let looked = 0;
    const flipping = async () => {
      looked += 1;
      return looked === 1 ? ['127.0.0.1'] : ['10.0.0.5'];
    };
    const flippingTarget = await resolveTarget(`http://flips.invalid:${port}/rebinds`, { resolve: flipping });
    const rebound = await fetchTarget(flippingTarget, { ...limits, resolve: flipping }).catch((error) => error) as { code: string; detail: string };
    assert.equal(rebound.code, 'fetch_redirect_denied');
    assert.match(rebound.detail, /private/);
    assert.equal(looked, 2, 'the hop was resolved again instead of reused');

    const failed = await fetchTarget(await resolveTarget(`${origin}/gone`), limits).catch((error) => error) as { code: string };
    assert.equal(failed.code, 'fetch_response_failed');
  } finally {
    server.close();
  }
});

test('a same-origin redirect cannot connect to a new IP outside the original approval set', async (t) => {
  let redirectedHits = 0;
  const initial = createServer((_request, response) => {
    response.writeHead(302, { location: '/final' });
    response.end();
  });
  await new Promise((resolve, reject) => initial.once('error', reject).listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = (initial.address() as AddressInfo).port;
  const rebound = createServer((_request, response) => {
    redirectedHits += 1;
    response.writeHead(200);
    response.end('REACHED_UNAPPROVED_IP');
  });
  await new Promise((resolve, reject) => rebound.once('error', reject).listen(port, '127.0.0.2', () => resolve(undefined)));
  t.after(async () => {
    await Promise.all([initial, rebound].map((server) => new Promise((resolve) => server.close(resolve))));
  });

  let resolutions = 0;
  const resolve = async (host: string) => {
    assert.equal(host, 'rebound.invalid');
    resolutions += 1;
    return resolutions === 1 ? ['127.0.0.1'] : ['127.0.0.2'];
  };
  const approved = await resolveTarget(`http://rebound.invalid:${port}/start`, { resolve });
  const result = await fetchTarget(approved, { ...limits, resolve }).catch((error) => error) as { code: string; detail: string };

  assert.equal(result.code, 'fetch_redirect_denied');
  assert.match(result.detail, /outside the approved address set/u);
  assert.equal(redirectedHits, 0, 'the unapproved loopback server must receive no request');
  assert.equal(resolutions, 2);
});

test('a same-origin redirect may select another IP that was already approved and reports actual connection addresses', async (t) => {
  const seen: { server: string; local: string | undefined; url: string | undefined }[] = [];
  const initial = createServer((request, response) => {
    seen.push({ server: 'initial', local: request.socket.localAddress, url: request.url });
    response.writeHead(302, { location: '/final' });
    response.end();
  });
  await new Promise((resolve, reject) => initial.once('error', reject).listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = (initial.address() as AddressInfo).port;
  const final = createServer((request, response) => {
    seen.push({ server: 'final', local: request.socket.localAddress, url: request.url });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('approved-final');
  });
  await new Promise((resolve, reject) => final.once('error', reject).listen(port, '127.0.0.2', () => resolve(undefined)));
  t.after(async () => {
    await Promise.all([initial, final].map((server) => new Promise((resolve) => server.close(resolve))));
  });

  let resolutions = 0;
  const resolve = async (host: string) => {
    assert.equal(host, 'approved.invalid');
    resolutions += 1;
    return resolutions === 1 ? ['127.0.0.1', '127.0.0.2'] : ['127.0.0.2'];
  };
  const approved = await resolveTarget(`http://approved.invalid:${port}/start`, { resolve });
  const page = await fetchTarget(approved, { ...limits, resolve });

  assert.equal(page.text, 'approved-final');
  assert.deepEqual(seen, [
    { server: 'initial', local: '127.0.0.1', url: '/start' },
    { server: 'final', local: '127.0.0.2', url: '/final' },
  ]);
  assert.deepEqual(page.addresses, ['127.0.0.1', '127.0.0.2']);
  assert.equal(resolutions, 2);
});

test('the fetch tool records the IP used by the socket, not every address in the approved DNS set', async (t) => {
  let remoteAddress: string | undefined;
  const server = createServer((request, response) => {
    remoteAddress = request.socket.remoteAddress;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('actual-address');
  });
  const { port } = await listening(server);
  t.after(() => server.close());

  const target = await resolveTarget(`http://approved.invalid:${port}/`, {
    resolve: async () => ['127.0.0.1', '127.0.0.2'],
  });
  const result = await fetchTool.run({ url: target.url }, {
    config: createConfig({ user: { boundary: process.cwd() } }),
    target,
  });

  assert.equal(remoteAddress, '127.0.0.1');
  assert.deepEqual(result.addresses, [remoteAddress]);
});

test('shownBytes uses source UTF-8 bytes for ASCII, CJK, emoji, and a truncated partial code point', async (t) => {
  const responses = new Map([
    ['/ascii', 'abcd-more'],
    ['/cjk', '文文'],
    ['/emoji', '😀😀'],
    ['/partial', '文文'],
  ]);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(responses.get(request.url ?? '') ?? '');
  });
  const { origin } = await listening(server);
  t.after(() => server.close());

  for (const { path, maxBytes, expectedShownBytes, expectedTotalBytes, expectedText } of [
    { path: '/ascii', maxBytes: 4, expectedShownBytes: 4, expectedTotalBytes: 9, expectedText: 'abcd' },
    { path: '/cjk', maxBytes: 3, expectedShownBytes: 3, expectedTotalBytes: 6, expectedText: '文' },
    { path: '/emoji', maxBytes: 4, expectedShownBytes: 4, expectedTotalBytes: 8, expectedText: '😀' },
    { path: '/partial', maxBytes: 4, expectedShownBytes: 4, expectedTotalBytes: 6, expectedText: '文�' },
  ]) {
    const page = await fetchTarget(await resolveTarget(`${origin}${path}`), { ...limits, maxBytes });
    assert.equal(page.text.split('\n[truncated:')[0], expectedText, path);
    assert.equal(page.shownBytes, expectedShownBytes, path);
    assert.equal(page.bytes, expectedTotalBytes, path);
    assert.match(page.text, new RegExp(`\\[truncated: ${expectedShownBytes} of ${expectedTotalBytes} bytes shown\\]`), path);
  }
});

test('a page that never answers is stopped by the timeout', async () => {
  const server = createServer(() => {
    // 故意不回：这一条要由超时收掉。
  });
  const { origin } = await listening(server);
  try {
    const error = await fetchTarget(await resolveTarget(`${origin}/slow`), { ...limits, timeoutMs: 60 }).catch((failure) => failure) as { code: string; detail: string };
    assert.equal(error.code, 'fetch_transport_failed');
    assert.match(error.detail, /no answer within 60ms/);
  } finally {
    server.close();
  }
});

test('the session record shows which host and which addresses were fetched', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello from the note');
  });
  const { origin } = await listening(server);
  const root = await mkdtemp(join(tmpdir(), 'ligule-fetch-record-'));
  const session = createSessionLog({ directory: root, id: 'one' });
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }), session });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  try {
    await kernel.call('fetch', { url: `${origin}/note` });
    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['tool']);
    const [event] = events as unknown as { tool: string; result: { content: { text: string; host: string; addresses: string[]; bytes: number } } }[];
    assert.equal(event.tool, 'fetch');
    assert.equal(event.result.content.text, 'hello from the note');
    // 记录中包含请求域名、实际响应字节数和允许访问的地址类型。
    assert.equal(event.result.content.host, '127.0.0.1');
    assert.deepEqual(event.result.content.addresses, ['127.0.0.1']);
    assert.equal(event.result.content.bytes, 19);
    assert.match(await readFile(join(root, 'one.jsonl'), 'utf8'), /"targetClass":"loopback"/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

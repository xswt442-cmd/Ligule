import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from '../dist/host/connection.js';
import type { Connection } from '../dist/host/connection.js';
import { KernelError } from '../dist/kernel/error.js';
import type { ProviderDiagnostic } from '../dist/kernel/error.js';

test('a request made after the input closes rejects instead of waiting forever', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  input.end();
  await new Promise((resolve) => input.once('end', resolve));

  await assert.rejects(
    Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('the request stayed pending'); }),
    ]),
    (error) => (error as { code?: string }).code === 'connection_closed',
  );
});

test('closing the input rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const pending = assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');

  input.destroy();
  await once(input, 'close');

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after the input closed'); }),
  ]);
  await assert.rejects(
    Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('a new request stayed open after the input closed'); }),
    ]),
    (error) => (error as { code?: string }).code === 'connection_closed',
  );
  output.destroy();
});

test('an input error reports the original fault and rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const faults: Error[] = [];
  const connection = createConnection({ input, output, onFault: (error) => faults.push(error) });
  const pending = assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');
  const failure = new Error('input failed');
  const errorEvent = once(input, 'error');
  const closeEvent = new Promise((resolve) => input.once('close', resolve));

  input.destroy(failure);
  assert.equal((await errorEvent)[0], failure);
  await closeEvent;

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after an input error'); }),
  ]);
  assert.deepEqual(faults, [failure]);
  await assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');
  output.destroy();
});

test('an output error reports the original fault and rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const faults: Error[] = [];
  const connection = createConnection({ input, output, onFault: (error) => faults.push(error) });
  const pending = assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');
  const failure = new Error('output failed');
  const errorEvent = once(output, 'error');
  const closeEvent = new Promise((resolve) => output.once('close', resolve));

  output.destroy(failure);
  assert.equal((await errorEvent)[0], failure);
  await closeEvent;

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after an output error'); }),
  ]);
  assert.deepEqual(faults, [failure]);
  await assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');
  input.destroy();
});

test('an output close prevents both queued and later inbound requests from executing', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const dispatched: string[] = [];
  connection.onRequest(({ method }) => {
    dispatched.push(method);
    return { performed: true };
  });

  try {
    // The first line has already scheduled its dispatch when the reply channel closes.
    input.write(`${JSON.stringify({ id: 'before-close', method: 'tool.write' })}\n`);
    output.emit('close');
    input.write(`${JSON.stringify({ id: 'after-close', method: 'tool.delete' })}\n`);
    await delay(0);
    assert.deepEqual(dispatched, [], 'neither RPC may mutate state without a reply channel');
    await assert.rejects(connection.request('status.get'), (error) => (error as { code?: string }).code === 'connection_closed');
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('closing the output during an inbound batch stops dispatching later lines', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const dispatched: string[] = [];
  connection.onNotification(() => { output.emit('close'); });
  connection.onRequest(({ method }) => { dispatched.push(method); return 'ok'; });

  try {
    input.write(
      `${JSON.stringify({ notify: 'shutdown' })}\n`
      + `${JSON.stringify({ id: 'late-request', method: 'tool.write' })}\n`,
    );
    await delay(0);
    assert.deepEqual(dispatched, [], 'remaining lines in the same chunk must be dropped');
  } finally {
    input.destroy();
    output.destroy();
  }
});


test('transport close invokes onClose once across all shutdown event paths', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let count = 0;
  const connection = createConnection({ input, output, onClose: () => { count += 1; } });
  output.emit('close');
  input.emit('end');
  input.emit('close');
  output.emit('error', new Error('late output fault'));
  await delay(0);
  assert.equal(count, 1);
  await assert.rejects(connection.request('status.get'), { code: 'connection_closed' });
  input.destroy();
  output.destroy();
});


test('input fault is delivered before shutdown while output is writable', async () => {
  const input = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const output = new Writable({ write(chunk, _encoding, done) { frames.push(JSON.parse(chunk.toString('utf8'))); done(); } });
  let closed = 0;
  let connection: Connection;
  connection = createConnection({
    input, output,
    onFault: (error) => connection.notify({ notify: 'fault', code: 'input_failed', detail: error.message }),
    onClose: () => { closed += 1; },
  });
  input.emit('error', new Error('read broke'));
  assert.deepEqual(frames, [{ notify: 'fault', code: 'input_failed', detail: 'read broke' }]);
  assert.equal(closed, 1);
  await assert.rejects(connection.request('status.get'), { code: 'connection_closed' });
  input.destroy();
  output.destroy();
});

test('failed fault notification cannot prevent connection cleanup', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  let closed = 0;
  const connection = createConnection({
    input, output,
    onFault: () => { throw new Error('notification unavailable'); },
    onClose: () => { closed += 1; },
  });
  input.emit('error', new Error('input broke'));
  assert.equal(closed, 1);
  await assert.rejects(connection.request('status.get'), { code: 'connection_closed' });
  input.destroy();
  output.destroy();
});

test('provider diagnostics cross Host protocol errors without exposing provider response content', async () => {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const host = createConnection({ input: toHost, output: toClient });
  const client = createConnection({ input: toClient, output: toHost });
  const diagnostics: ProviderDiagnostic = {
    category: 'rate_limit', status: 429, attempts: 2,
    responseReceived: true, streamReceived: false, recoverable: true,
  };
  host.onRequest(() => { throw new KernelError('provider_http_error', {
    detail: 'HTTP 429', diagnostics,
  }); });

  try {
    await assert.rejects(client.request('run.start'), (error) => {
      const failure = error as KernelError;
      assert.equal(failure.code, 'provider_http_error');
      assert.deepEqual(failure.diagnostics, diagnostics);
      assert.equal(Object.isFrozen(failure.diagnostics), true);
      assert.equal(JSON.stringify(error).includes('response body'), false);
      return true;
    });
  } finally {
    toHost.destroy();
    toClient.destroy();
  }
});

test('a synchronous response arriving during write settles the request', async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString('utf8'));
      input.write(`${JSON.stringify({ id: request.id, result: 'ok' })}\n`);
      callback();
    },
  });
  const connection = createConnection({ input, output });

  try {
    assert.equal(await Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('the synchronous response was lost'); }),
    ]), 'ok');
  } finally {
    input.destroy();
    output.destroy();
  }
});

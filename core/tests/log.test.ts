import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, KernelError } from '../dist/index.js';
import type { LoggerBackend } from '../dist/kernel/log.js';

type RecordedCall = [level: string, message: string, fields: unknown];

function recordingSink(withError: boolean): { seen: RecordedCall[]; logger: LoggerBackend } {
  const seen: RecordedCall[] = [];
  return {
    seen,
    logger: {
      debug: (message, fields) => seen.push(['debug', message, fields]),
      log: (message, fields) => seen.push(['log', message, fields]),
      ...withError === false ? {} : { error: (message, fields) => seen.push(['error', message, fields]) },
    },
  };
}

test('an absent logger writes nothing anywhere', (t) => {
  const write = t.mock.method(process.stdout, 'write');
  const logger = createLogger();
  logger.debug('d');
  logger.log('l');
  logger.error('e', { toolName: 'read' });
  assert.equal(write.mock.callCount(), 0);
});

test('the injected backend receives every call', () => {
  const { seen, logger } = recordingSink(true);
  const host = createLogger(logger);
  host.debug('starting', { runId: 1 });
  host.log('done');
  host.error('failed', { toolName: 'read' });
  assert.deepEqual(seen, [
    ['debug', 'starting', { runId: 1 }],
    ['log', 'done', undefined],
    ['error', 'failed', { toolName: 'read' }],
  ]);
});

test('a host that leaves out error still gets the failure through log with a severity', () => {
  const { seen, logger } = recordingSink(false);
  createLogger(logger).error('boom', { toolName: 'exec' });
  assert.deepEqual(seen, [['log', 'boom', { toolName: 'exec', severity: 'error' }]]);
});

test('a backend missing a required method fails at once', () => {
  assert.throws(
    () => createLogger({ log: () => {} } as unknown as LoggerBackend),
    (error) => error instanceof KernelError && error.code === 'logger_debug_and_log_required',
  );
  assert.throws(
    () => createLogger({ debug: () => {}, log: () => {}, error: 'stdout' } as unknown as LoggerBackend),
    (error) => (error as { code?: string }).code === 'logger_error_must_be_function',
  );
});

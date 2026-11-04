import test from 'node:test';
import assert from 'node:assert/strict';
import { KernelError, probeBackend } from '../dist/index.js';

function recordingLogger() {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    logger: { debug: () => {}, log: () => {}, error: (message: string, fields: Record<string, unknown>) => seen.push(fields) },
  };
}

test('a measured enforcement level is reported as measured, partial included', async () => {
  assert.deepEqual(await probeBackend({ name: 'seatbelt', probe: () => 'full' }), { name: 'seatbelt', enforced: 'full' });
  assert.deepEqual(await probeBackend({ name: 'windows', probe: async () => 'partial' }), { name: 'windows', enforced: 'partial' });
});

test('a probe that throws comes back as an error code instead of throwing', async () => {
  const { seen, logger } = recordingLogger();
  const result = await probeBackend({
    name: 'broken',
    probe: () => {
      throw new Error('sandbox-exec is missing');
    },
  }, logger);
  assert.deepEqual(result, { name: 'broken', enforced: 'none', code: 'capability_probe_failed' });
  assert.equal(seen[0].cause, 'sandbox-exec is missing');
});

test('a backend that cannot probe is reported as not enforced', async () => {
  assert.deepEqual(await probeBackend({ name: 'plain' }), { name: 'plain', enforced: 'none', code: 'capability_probe_missing' });
});

test('a probe result outside the three levels is rejected', async () => {
  assert.deepEqual(
    await probeBackend({ name: 'weird', probe: () => true }),
    { name: 'weird', enforced: 'none', code: 'capability_probe_result_invalid' },
  );
});

test('a backend without a name fails at once', async () => {
  await assert.rejects(
    () => probeBackend({ probe: () => 'full' }),
    (error) => error instanceof KernelError && error.code === 'backend_name_required',
  );
});

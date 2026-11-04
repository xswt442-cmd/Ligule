import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernel } from '../dist/kernel/kernel.js';
import { captureScreen, checkedCaptureOptions } from '../dist/capability/screen-capture.js';
import { createOwnedProcessJob } from '../dist/capability/win32-job.js';
import { createScreenshotPlugin } from '../dist/tools/screenshot.js';

test('screen capture accepts only bounded target and region options', () => {
  assert.deepEqual(checkedCaptureOptions({}), { target: 'screen' });
  assert.deepEqual(checkedCaptureOptions({ target: 'active-window', region: { x: 1, y: 2, width: 10, height: 20 } }),
    { target: 'active-window', region: { x: 1, y: 2, width: 10, height: 20 } });
  for (const options of [null, [], { target: 'arbitrary-window' }, { path: 'elsewhere.png' },
    { region: { x: -1, y: 0, width: 2, height: 2 } }, { region: { x: 0, y: 0, width: 9000, height: 9000 } },
    { region: { x: 0, y: 0, width: 2, height: 2, arbitrary: true } }]) {
    assert.throws(() => checkedCaptureOptions(options));
  }
});

test('a pre-cancelled capture rejects before starting a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureScreen({}, controller.signal), { name: 'AbortError' });
});

test('a registered screenshot tool cannot infer authorization from model support', async () => {
  const kernel = createKernel();
  const undo = createScreenshotPlugin({ supportsImages: () => true }).setup(kernel);
  try {
    await assert.rejects(kernel.call('screenshot', {}), { code: 'screen_capture_not_authorized' });
    await assert.rejects(kernel.call('screenshot', { outputPath: 'arbitrary.png' }), { code: 'tool_args_invalid' });
  } finally { undo(); }
});

test('non-Windows capture is explicitly unsupported', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(captureScreen(), { code: 'screenshot_platform_unsupported' });
});

test('the Windows capture Job owns a real child by PID and closes it', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const job = await createOwnedProcessJob({ assignCurrentProcess: false, processMemoryBytes: 256 * 1024 * 1024 });
  const child = spawn(process.execPath, ['-e', 'process.send({ready:true});setInterval(()=>{},1000)'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const closed = once(child, 'close');
  try {
    await once(child, 'message');
    job.assignPid(child.pid!);
    job.close();
    const deadline = new AbortController();
    try {
      await Promise.race([closed, delay(3000, undefined, { signal: deadline.signal }).then(() => { throw new Error('capture_job_did_not_stop_child'); })]);
    } finally { deadline.abort(); }
    assert.notEqual(child.exitCode, null);
  } finally { job.close(); if (child.exitCode === null) child.kill(); await closed; }
});

test('cancelling worker startup reclaims the actual Windows process', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  await assert.rejects(captureScreen({}, AbortSignal.timeout(1)), { code: 'screenshot_cancelled' });
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { clipboardPayload, copyToClipboard, lastAnswer, writeClipboard } from '../dist/tui/clipboard.js';

async function withDirectory(run: (directory: string) => Promise<void>) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'clipboard-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test('clipboard payload preserves the platform encoding and lastAnswer selects the newest answer', async () => {
  assert.deepEqual(clipboardPayload('阶段', 'win32'), Buffer.from('阶段', 'utf16le'));
  assert.deepEqual(clipboardPayload('阶段', 'linux'), Buffer.from('阶段', 'utf8'));
  assert.equal(lastAnswer([
    { kind: 'assistant', text: 'older' },
    { kind: 'assistant', text: '' },
    { kind: 'assistant', text: 'newest' },
  ]), 'newest');
  assert.equal((await copyToClipboard('unused', 'freebsd') as { code: string }).code, 'tui_clipboard_unavailable');
});

test('a missing clipboard program is unavailable and a closed stdin reports failure without crashing', async () => {
  await withDirectory(async (directory) => {
    const missing = join(directory, 'clipboard-program-that-does-not-exist');
    const unavailable = await writeClipboard(missing, [], Buffer.from('payload')) as { code: string; detail: string };
    assert.equal(unavailable.code, 'tui_clipboard_unavailable');
    assert.match(unavailable.detail, /ENOENT/);

    const failed = await writeClipboard(process.execPath, ['--version'], Buffer.alloc(16 * 1024 * 1024)) as { code: string; detail: string };
    assert.equal(failed.code, 'tui_clipboard_failed');
    assert.match(failed.detail, /EPIPE|EOF|closed|destroyed/i);
  });
});

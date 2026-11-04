import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { editInExternalEditor } from '../../core/dist/capability/editor.js';

const testplace = resolve(dirname(fileURLToPath(import.meta.url)), '../testplace');
const editorFixture = fileURLToPath(new URL('./fixtures/editor.mjs', import.meta.url));
const commandFixture = fileURLToPath(new URL('./fixtures/editor.cmd', import.meta.url));

async function withDirectory(run: (directory: string) => Promise<void>) {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'editor test-'));
  try {
    await run(directory);
  } finally {
    const absoluteDirectory = resolve(directory);
    const relativeDirectory = relative(testplace, absoluteDirectory);
    assert.ok(relativeDirectory !== '' && !isAbsolute(relativeDirectory) && relativeDirectory !== '..' && !relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
    // Windows 可能在子进程退出后短暂保留文件句柄，因此删除失败时重试几次。
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await rm(absoluteDirectory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  }
}

function quoted(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

test('external editor passes a spaced executable path and parameter and removes one final CRLF', async () => {
  await withDirectory(async (directory) => {
    const executable = join(directory, process.platform === 'win32' ? 'node with spaces.exe' : 'node with spaces');
    const marker = join(directory, 'marker file.txt');
    await copyFile(process.execPath, executable);
    const command = `${quoted(executable)} ${quoted(editorFixture)} append-crlf ${quoted(marker)} ${quoted('argument with spaces')} -`;
    const result = await editInExternalEditor(command, 'draft');
    assert.deepEqual(result, { text: 'draft edited' });
    assert.equal(await readFile(marker, 'utf8'), 'argument with spaces');
  });
});

test('external editor returns an explicit failure and the child exit code', async () => {
  await withDirectory(async (directory) => {
    const marker = join(directory, 'marker.txt');
    const command = `${quoted(process.execPath)} ${quoted(editorFixture)} exit ${quoted(marker)} value 17`;
    const result = await editInExternalEditor(command, 'draft') as { code: string; detail: string };
    assert.equal(result.code, 'tui_editor_failed');
    assert.match(result.detail, /17/);
  });
});

test('external editor rejects empty and unbalanced command text with enumerable details', async () => {
  const empty = await editInExternalEditor('   ', 'draft') as { code: string; detail: string };
  assert.deepEqual(empty, { code: 'tui_editor_command_invalid', detail: 'EDITOR must contain a program name' });
  const unbalanced = await editInExternalEditor('"unfinished', 'draft') as { code: string; detail: string };
  assert.equal(unbalanced.code, 'tui_editor_command_unbalanced');
  assert.match(unbalanced.detail, /quote open/);
  assert.ok(Object.keys(unbalanced).includes('detail'));
});

test('external editor resolves a Windows cmd shim with spaced arguments', { skip: process.platform !== 'win32' }, async () => {
  await withDirectory(async (directory) => {
    const commandPath = join(directory, 'editor shim.cmd');
    const marker = join(directory, 'marker file.txt');
    await copyFile(commandFixture, commandPath);
    const command = `${quoted(commandPath)} ${quoted(marker)} ${quoted('argument with spaces')}`;
    const result = await editInExternalEditor(command, 'draft');
    assert.deepEqual(result, { text: 'edited' });
    assert.match(await readFile(marker, 'utf8'), /argument with spaces/);
  });
});

test('external editor reports a missing readback file', async () => {
  await withDirectory(async (directory) => {
    const marker = join(directory, 'marker.txt');
    const command = `${quoted(process.execPath)} ${quoted(editorFixture)} remove ${quoted(marker)} value -`;
    const result = await editInExternalEditor(command, 'draft') as { code: string; detail: string };
    assert.equal(result.code, 'tui_editor_file_read_failed');
    assert.match(result.detail, /draft\.md/);
  });
});

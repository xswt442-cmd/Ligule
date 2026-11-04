import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createConfig, createKernel, createPromptAssembly, createSessionLog, loadAssembly, minimalPlugin,
} from '../dist/index.js';
import { adoptSessionMode } from '../dist/host/session-mode.js';
import type { ModeFile } from '../dist/kernel/modes.js';

test('a mode persistence failure leaves the previous kernel and prompt state active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-session-mode-'));
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  const assembly = loadAssembly(kernel, [minimalPlugin]);
  const prompt = createPromptAssembly();
  const session = createSessionLog({ directory, id: 'mode-rollback' });
  const mode = { file: undefined, tools: [], undo: () => {} };
  const readonly: ModeFile = { name: 'readonly', layer: 'user', digest: 'readonly-digest', path: 'readonly.toml', tools: ['read'], prompt: [] };
  const wide: ModeFile = { name: 'wide', layer: 'user', digest: 'wide-digest', path: 'wide.toml', tools: ['read', 'find'], prompt: [] };
  try {
    await session.acquire();
    await adoptSessionMode({ file: readonly, kernel, prompt, fragments: [], promptFragmentBytes: 8_000, session, mode });
    const beforePrompt = prompt.render();
    const append = session.append;
    let releaseAppend: () => void = () => {};
    let appendStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { appendStarted = () => resolve(); });
    const blocked = new Promise<void>((resolve) => { releaseAppend = () => resolve(); });
    session.append = async () => {
      appendStarted();
      await blocked;
      throw new Error('simulated session persistence failure');
    };
    const adopting = adoptSessionMode({ file: wide, kernel, prompt, fragments: [], promptFragmentBytes: 8_000, session, mode });
    await started;
    assert.equal(mode.file, readonly);
    assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
    assert.equal(prompt.render(), beforePrompt);
    releaseAppend();
    await assert.rejects(
      adopting,
      /simulated session persistence failure/,
    );
    session.append = append;

    assert.equal(mode.file, readonly);
    assert.deepEqual(mode.tools, ['read']);
    assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
    assert.equal(prompt.render(), beforePrompt);
    assert.deepEqual((await session.read()).filter((event) => event.kind === 'mode').map((event) => event.name), ['readonly']);
  } finally {
    await session.close();
    assembly.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

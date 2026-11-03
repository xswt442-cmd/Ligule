import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, createPermissionContext, KernelError, loadAssembly, minimalPlugin } from '../dist/index.js';
import type { Kernel, ToolDefinition } from '../dist/kernel/kernel.js';
import type { Plugin } from '../dist/kernel/assembly.js';

const manifestPermission = createPermissionContext('workspace-write', 'policy', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'full', process: 'full',
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    access: name === 'exec' ? 'exec' : 'read',
    parameters: { type: 'object', properties: {} },
    run: async () => 'ok',
  };
}

function plugin(name: string, registered: readonly string[], disposed: string[]): Plugin<Kernel> {
  return {
    name,
    setup(kernel) {
      const disposers = registered.map((toolName) => kernel.register(tool(toolName)));
      return () => {
        for (const dispose of disposers.reverse()) dispose();
        disposed.push(name);
      };
    },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

test('an empty manifest leaves the kernel with nothing and the assembly list empty', () => {
  const instance = createKernel();
  const assembly = loadAssembly(instance, []);
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.list(), []);
});

test('the manifest reads back which plugins this run installed', () => {
  const instance = createKernel();
  const disposed: string[] = [];
  const assembly = loadAssembly(instance, [
    plugin('files', ['read'], disposed),
    plugin('shell', ['exec'], disposed),
  ]);
  assert.deepEqual(assembly.list(), ['files', 'shell']);
  assert.deepEqual(instance.list(), ['exec', 'read']);
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['shell', 'files']);
});

test('two plugins declaring the same tool name fail the whole load and leave nothing installed', () => {
  const instance = createKernel();
  const disposed: string[] = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      plugin('archive', ['read'], disposed),
    ]),
    (error) => error instanceof KernelError && error.code === 'tool_already_registered',
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin that does not hand back a dispose action is rejected and the earlier ones are unwound', () => {
  const instance = createKernel();
  const disposed: string[] = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      { name: 'forgetful', setup: () => undefined },
    ]),
    (error) => hasCode(error, 'plugin_dispose_required'),
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('a plugin whose setup throws is unwound the same way', () => {
  const instance = createKernel();
  const disposed: string[] = [];
  assert.throws(
    () => loadAssembly(instance, [
      plugin('files', ['read'], disposed),
      {
        name: 'broken',
        setup: () => {
          throw new Error('boom');
        },
      },
    ]),
    (error) => error instanceof Error && error.message === 'boom',
  );
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(disposed, ['files']);
});

test('the minimal manifest is exactly the eight tools decided in D3 and unloads completely', () => {
  const instance = createKernel({ permission: manifestPermission });
  const assembly = loadAssembly(instance, [minimalPlugin]);
  assert.deepEqual(assembly.list(), ['ligule-minimal']);
  assert.deepEqual(instance.list(), ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search', 'write']);
  assert.deepEqual(instance.manifest().map((entry) => entry.name), instance.list());
  assembly.dispose();
  assert.deepEqual(assembly.list(), []);
  assert.deepEqual(instance.manifest(), []);
});

test('the manifest rejects a duplicate plugin name and a malformed entry', () => {
  const instance = createKernel();
  const disposed: string[] = [];
  assert.throws(
    () => loadAssembly(instance, [plugin('files', ['read'], disposed), plugin('files', ['search'], disposed)]),
    (error) => hasCode(error, 'plugin_name_duplicate'),
  );
  assert.throws(() => loadAssembly(instance, [{ setup: () => () => {} }] as unknown as Plugin<Kernel>[]), (error) => hasCode(error, 'plugin_name_required'));
  assert.throws(() => loadAssembly(instance, [{ name: 'x' }] as unknown as Plugin<Kernel>[]), (error) => hasCode(error, 'plugin_setup_required'));
  assert.throws(() => loadAssembly(instance, 'files' as unknown as Plugin<Kernel>[]), (error) => hasCode(error, 'assembly_manifest_must_be_array'));
  assert.deepEqual(instance.list(), []);
});

test('assembly disposal attempts every cleanup in reverse order and can be repeated', () => {
  const instance = createKernel();
  const calls: string[] = [];
  const failure = new Error('second cleanup failed');
  const thirdFailure = new Error('third cleanup failed');
  const assembly = loadAssembly(instance, [
    { name: 'first', setup: (kernel) => { const remove = kernel.register(tool('first-tool')); return () => { calls.push('first'); remove(); }; } },
    { name: 'second', setup: (kernel) => { const remove = kernel.register(tool('second-tool')); return () => { calls.push('second'); remove(); throw failure; }; } },
    { name: 'third', setup: (kernel) => { const remove = kernel.register(tool('third-tool')); return () => { calls.push('third'); remove(); throw thirdFailure; }; } },
  ]);
  assert.throws(() => assembly.dispose(), (error) => error instanceof AggregateError && error.errors[0] === thirdFailure && error.errors[1] === failure);
  assert.deepEqual(calls, ['third', 'second', 'first']);
  assert.deepEqual(instance.list(), []);
  assert.deepEqual(assembly.list(), []);
  assembly.dispose();
  assert.deepEqual(calls, ['third', 'second', 'first']);
});

test('a setup failure remains reported alongside cleanup failures', () => {
  const instance = createKernel();
  const setupFailure = new Error('setup failed');
  const cleanupFailure = new Error('cleanup failed');
  assert.throws(() => loadAssembly(instance, [
    { name: 'first', setup: (kernel) => { const remove = kernel.register(tool('first-tool')); return () => { remove(); throw cleanupFailure; }; } },
    { name: 'broken', setup: () => { throw setupFailure; } },
  ]), (error) => error instanceof AggregateError && error.errors[0] === setupFailure && error.errors[1] === cleanupFailure);
  assert.deepEqual(instance.list(), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, createSlotRegistry, loadAssembly } from '../dist/index.js';

const panelSlot = { name: 'panel', accepts: (payload: { title?: unknown }) => typeof payload?.title === 'string' };

test('the registry starts from the host-declared slots and holds nothing', () => {
  const registry = createSlotRegistry([panelSlot]);
  assert.deepEqual(registry.names(), ['panel']);
  assert.deepEqual(registry.list('panel'), []);
});

test('an undeclared slot and a payload of the wrong shape are both refused', () => {
  const registry = createSlotRegistry([panelSlot]);
  assert.throws(() => registry.register('sidebar', { title: 'x' }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'slot_unknown');
  assert.throws(() => registry.register('panel', { title: 7 }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'slot_payload_rejected');
  assert.throws(() => registry.list('sidebar'), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'slot_unknown');
});

test('two plugins may fill one slot and each unload removes only its own entry', () => {
  const registry = createSlotRegistry([panelSlot]);
  const first = registry.register('panel', { title: 'files' });
  registry.register('panel', { title: 'shell' });
  assert.deepEqual(registry.list('panel'), [{ title: 'files' }, { title: 'shell' }]);
  first();
  first();
  assert.deepEqual(registry.list('panel'), [{ title: 'shell' }]);
});

test('清单第 6 条：卸载插件后工具与槽位都不残留', () => {
  const registry = createSlotRegistry([panelSlot]);
  const kernel = createKernel();
  const assembly = loadAssembly(kernel, [
    {
      name: 'browser',
      setup: (host) => {
        const disposeTool = host.register({
          name: 'browse',
          description: 'open a page',
          parameters: { type: 'object', properties: {} },
          run: async () => ({ text: 'ok' }),
        });
        const disposePanel = registry.register('panel', { title: 'browser' });
        return () => {
          disposePanel();
          disposeTool();
        };
      },
    },
  ]);
  assert.deepEqual(kernel.list(), ['browse']);
  assert.deepEqual(registry.list('panel'), [{ title: 'browser' }]);
  assembly.dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(registry.list('panel'), []);
});

test('a host that declares its slots never names a plugin', () => {
  const registry = createSlotRegistry([panelSlot, { name: 'status', accepts: () => true }]);
  assert.deepEqual(registry.names(), ['panel', 'status']);
});

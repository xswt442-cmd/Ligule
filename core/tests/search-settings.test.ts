import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../dist/kernel/config.js';
import { searchSettingsOf } from '../dist/kernel/search-settings.js';

const service = (overrides = {}) => ({
  id: 'deepseek-official',
  name: 'DeepSeek',
  api: 'chat-completions',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_REFERENCE',
  models: ['deepseek-chat'],
  ...overrides,
});

const search = { provider: 'deepseek', serviceId: 'deepseek-official' };

test('an explicitly injected trusted config resolves a bound service reference only', () => {
  const config = createConfig({ user: { search, model: { services: [service()] } } });
  assert.deepEqual(searchSettingsOf(config), {
    provider: 'deepseek', serviceId: 'deepseek-official', apiKeyEnv: 'DEEPSEEK_REFERENCE',
  });
  assert.equal(searchSettingsOf(createConfig({ user: { model: { services: [service()] } } })), undefined);
});

test('when layers are supplied, only user, flag, and managed search settings and catalogs participate', () => {
  const layers = {
    user: { search, model: { services: [service()] } },
    project: { search: { provider: 'attacker', serviceId: 'project' }, model: { services: [service({ baseURL: 'https://attacker.example' })] } },
    local: { search: { provider: 'attacker-local', serviceId: 'local' }, model: { services: [service({ baseURL: 'https://local.example' })] } },
  };
  const merged = createConfig(layers);
  assert.deepEqual(searchSettingsOf(merged, layers), {
    provider: 'deepseek', serviceId: 'deepseek-official', apiKeyEnv: 'DEEPSEEK_REFERENCE',
  });
  assert.equal(searchSettingsOf(createConfig({ project: { search }, local: { model: { services: [service()] } } }), {
    project: { search }, local: { model: { services: [service()] } },
  }), undefined);
});

test('trusted flag and managed layers can explicitly select their own catalog entries', () => {
  const user = { search, model: { services: [service()] } };
  const flagService = service({ id: 'flag-service', apiKeyEnv: 'FLAG_REFERENCE' });
  const flag = { search: { provider: 'deepseek', serviceId: 'flag-service' }, model: { services: [flagService] } };
  assert.deepEqual(searchSettingsOf(createConfig({ user, flag }), { user, flag }), {
    provider: 'deepseek', serviceId: 'flag-service', apiKeyEnv: 'FLAG_REFERENCE',
  });

  const managedService = service({ id: 'managed-service', apiKeyEnv: 'MANAGED_REFERENCE' });
  const managed = { search: { provider: 'deepseek', serviceId: 'managed-service' }, model: { services: [managedService] } };
  assert.deepEqual(searchSettingsOf(createConfig({ user, managed }), { user, managed }), {
    provider: 'deepseek', serviceId: 'managed-service', apiKeyEnv: 'MANAGED_REFERENCE',
  });
});

test('untrusted layers cannot enable search or shadow a trusted service with the same id', () => {
  const user = { search, model: { services: [service()] } };
  const attackerService = service({ baseURL: 'https://attacker.example/v1', apiKeyEnv: 'ATTACKER_REFERENCE' });
  const layers = {
    user,
    project: { search: { provider: 'deepseek', serviceId: 'deepseek-official' }, model: { services: [attackerService] } },
    local: { search: { provider: 'deepseek', serviceId: 'deepseek-official' }, model: { services: [attackerService] } },
  };
  assert.deepEqual(searchSettingsOf(createConfig(layers), layers), {
    provider: 'deepseek', serviceId: 'deepseek-official', apiKeyEnv: 'DEEPSEEK_REFERENCE',
  });
});

test('trusted invalid selection or missing service fails with a search error', () => {
  for (const config of [
    createConfig({ user: { search: { provider: 'other', serviceId: 'deepseek-official' } } }),
    createConfig({ user: { search: { provider: 'deepseek', serviceId: 'missing' }, model: { services: [service()] } } }),
    createConfig({ user: { search: { provider: 'deepseek', serviceId: 'deepseek-official' } } }),
  ]) {
    assert.throws(() => searchSettingsOf(config), (error: unknown) => error instanceof Error && (error as unknown as { code: string }).code.startsWith('search_'));
  }
});

test('only the official HTTPS origin and approved API paths can supply a search reference', () => {
  for (const baseURL of [
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com.evil.example/v1',
    'https://user@api.deepseek.com/v1',
    'https://api.deepseek.com:444/v1',
    'https://api.deepseek.com/v1?key=value',
    'https://api.deepseek.com/v1#fragment',
    'https://api.deepseek.com/v2',
    'https://api.deepseek.com/v1//',
    'https://api.deepseek.com/anthropic/v1beta',
  ]) {
    const config = createConfig({ user: { search, model: { services: [service({ baseURL })] } } });
    assert.throws(() => searchSettingsOf(config), (error: unknown) => error instanceof Error && (error as unknown as { code: string }).code.startsWith('search_'), baseURL);
  }
  for (const baseURL of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic/v1/']) {
    const config = createConfig({ user: { search, model: { services: [service({ baseURL })] } } });
    assert.equal(searchSettingsOf(config)!.serviceId, 'deepseek-official');
  }
});

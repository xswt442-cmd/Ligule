import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { modelServices, resolveModel } from '../dist/kernel/model-services.js';
import { configVersion, writeConfigField } from '../dist/kernel/config-edit.js';

// 解析结果是嵌套表；测试只按表结构读它，收窄集中在这里。
type TomlTable = { readonly [key: string]: TomlTable };
const readToml = (text: string): TomlTable => parse(text) as unknown as TomlTable;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

const service = { id: 'deepseek', name: 'DeepSeek 🌿', api: 'chat-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'LIGULE_SERVICE_KEY', models: ['deepseek-reasoner', 'org/model-v2'] };

test('service validation rejects unknown fields, duplicate ids, unsafe URLs, and invalid references', () => {
  for (const value of [
    [{ ...service, unsupportedField: true }],
    [service, service],
    [{ ...service, baseURL: 'https://user:secret@example.test' }],
    [{ ...service, baseURL: 'https://example.test/?api_key=secret' }],
    [{ ...service, apiKeyEnv: 'not an environment variable' }],
    [{ ...service, models: [] }],
  ]) assert.throws(() => modelServices(value), error => hasCode(error, 'model_service_invalid'));
  assert.throws(() => resolveModel({ services: [service] }, { provider: 'missing', model: 'm' }), error => hasCode(error, 'model_service_not_found'));
  assert.throws(() => resolveModel({ services: [service] }, { provider: service.id, model: 'missing' }), error => hasCode(error, 'model_not_available'));
});

test('per-model settings validate ids, fields, uniqueness, and safe token budgets', () => {
  const valid = { ...service, modelSettings: [
    { id: service.models[0], name: 'Reasoner', contextTokens: 64000, outputTokens: 32000, imageInput: true },
    { id: service.models[1], imageInput: false },
  ] };
  assert.deepEqual(modelServices([valid])[0].modelSettings, valid.modelSettings);
  const invalid = [
    [{ ...service, modelSettings: [{ id: 'missing', outputTokens: 100 }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], outputTokens: 100 }, { id: service.models[0], contextTokens: 200 }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], outputTokens: 101, contextTokens: 100 }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], outputTokens: -1 }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], outputTokens: 1.5 }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], imageInput: 'true' }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], imageInput: null }] }],
    [{ ...service, modelSettings: [{ id: service.models[0], imageInput: 1 }] }],
    [{ ...service, modelSettings: [JSON.parse('{"id":"deepseek-reasoner","outputTokens":100,"__proto__":{"polluted":true}}')] }],
    [{ ...service, modelSettings: [{ id: service.models[0], unsupported: true }] }],
  ];
  for (const value of invalid) assert.throws(() => modelServices(value), error => hasCode(error, 'model_service_invalid'));
  const resolved = resolveModel({ services: [valid] }, { provider: service.id, model: service.models[0] });
  assert.equal(resolved.outputTokens, 32000);
  assert.equal(resolved.serviceOutputLimit, true);
  assert.equal(resolved.serviceContextTokens, 64000);
  assert.equal(resolved.serviceImageInput, true);
  assert.equal(resolveModel({ services: [valid] }, { provider: service.id, model: service.models[1] }).serviceImageInput, false);
  assert.equal(resolveModel({ services: [service] }, { provider: service.id, model: service.models[0] }).serviceOutputLimit, undefined);
  const forged = resolveModel({ api: service.api, baseURL: service.baseURL, model: service.models[0], serviceOutputLimit: true, serviceContextTokens: 1 });
  assert.equal(forged.serviceOutputLimit, undefined);
  assert.equal(forged.serviceContextTokens, undefined);
  const legacy = resolveModel({
    api: service.api, baseURL: service.baseURL, model: service.models[0], imageInput: true, serviceImageInput: true,
  }, { provider: 'legacy', model: service.models[0] });
  assert.equal(legacy.imageInput, true, 'the existing legacy setting remains unchanged');
  assert.equal(legacy.serviceImageInput, undefined, 'a user-supplied derived field is always removed');
  const switched = resolveModel({ services: [valid], serviceOutputLimit: true, serviceContextTokens: 1 }, { provider: service.id, model: service.models[1] });
  assert.equal(switched.serviceOutputLimit, undefined);
  assert.equal(switched.serviceContextTokens, undefined);
  const serviceSwitched = resolveModel({ ...resolved, services: [valid, { ...service, id: 'other', models: ['other-model'], modelSettings: undefined }] }, {
    provider: 'other', model: 'other-model',
  });
  assert.equal(serviceSwitched.serviceImageInput, undefined, 'a different service does not inherit the prior derived value');
});

test('service and default selection use versioned TOML writes and preserve unrelated bytes', async () => {
  const scratch = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'model-services-'));
  const file = join(root, 'config.toml');
  const untouched = '# another section\n[future]\nvalue = "中文" # preserve this\n';
  try {
    await writeFile(file, untouched, 'utf8');
    const saved = await writeConfigField(file, { field: 'model.services', value: [service], version: configVersion(untouched) });
    const text = await readFile(file, 'utf8');
    assert.equal(text.startsWith(untouched), true);
    assert.deepEqual(structuredClone(readToml(text).model.services), [service]);
    assert.equal(resolveModel(readToml(text).model).model, service.models[0]);
    const selected = await writeConfigField(file, { field: 'model.selection', value: { provider: service.id, model: service.models[1] }, version: saved.version });
    assert.equal(resolveModel(readToml(await readFile(file, 'utf8')).model).model, service.models[1]);
    await writeConfigField(file, { field: 'model.services', value: [{ ...service, name: 'Updated' }], version: selected.version });
    assert.equal((await readFile(file, 'utf8')).startsWith(untouched), true);
    const withSettings = [{ ...service, modelSettings: [
      { id: service.models[0], imageInput: true },
      { id: service.models[1], name: 'Custom', contextTokens: 96_000, outputTokens: 32_000, imageInput: false },
    ] }];
    const settingsWrite = await writeConfigField(file, { field: 'model.services', value: withSettings, version: configVersion(await readFile(file, 'utf8')) });
    assert.deepEqual(structuredClone(readToml(await readFile(file, 'utf8')).model.services), withSettings);
    const roundTrippedModel = readToml(await readFile(file, 'utf8')).model;
    assert.equal(resolveModel(roundTrippedModel, { provider: service.id, model: service.models[1] }).outputTokens, 32_000);
    assert.equal(resolveModel(roundTrippedModel, { provider: service.id, model: service.models[0] }).serviceImageInput, true);
    assert.equal(resolveModel(roundTrippedModel, { provider: service.id, model: service.models[1] }).serviceImageInput, false);
    assert.ok(settingsWrite.version);
    const commented = '[model]\nservices = [\n# keep this service comment\n{ id = "x", name = "X", api = "messages", baseURL = "https://example.test", apiKeyEnv = "KEY", models = ["m"] }\n]\n';
    await writeFile(file, commented, 'utf8');
    await assert.rejects(writeConfigField(file, { field: 'model.services', value: [service], version: configVersion(commented) }), error => hasCode(error, 'config_edit_shape_unsupported'));
    assert.equal(await readFile(file, 'utf8'), commented);
  } finally { await rm(root, { recursive: true, force: true }); }
});

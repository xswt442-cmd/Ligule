import test from 'node:test';
import assert from 'node:assert/strict';
import { browserToolPolicy, BROWSER_SERVER, assertBrowserArguments } from '../dist/capability/browser-policy.js';

type SchemaView = {
  type?: string;
  title?: string;
  properties: Record<string, Record<string, unknown>>;
  required?: string[] | string;
  additionalProperties?: boolean;
};

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

const schemaOf = (properties: Record<string, Record<string, unknown>>, required: string[] | string = []): SchemaView => ({
  type: 'object',
  properties,
  required,
  title: 'Input schema',
});

test('non-browser schemas retain identity and browser schemas are cloned and closed to unknown fields', () => {
  const untouched = schemaOf({ text: { type: 'string' } });
  assert.equal(browserToolPolicy('other-server', 'browser_navigate', untouched), untouched);

  const input = schemaOf({ url: { type: 'string', minLength: 1 } }, ['url']);
  const before = structuredClone(input);
  const filtered = browserToolPolicy(BROWSER_SERVER, 'browser_navigate', input) as SchemaView;
  assert.notEqual(filtered, input);
  assert.deepEqual(input, before, 'the caller schema is not mutated');
  assert.equal(filtered.additionalProperties, false);
  assert.equal(filtered.properties.url.maxLength, 8_192);
  assert.equal(filtered.properties.url.minLength, 1);
});

test('only the approved browser tools survive; filename is removed or disables required tools', () => {
  const allowed = [
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key',
    'browser_wait_for', 'browser_take_screenshot', 'browser_close', 'browser_handle_dialog',
  ];
  for (const tool of allowed) {
    assert.notEqual(browserToolPolicy(BROWSER_SERVER, tool, schemaOf({ action: { type: 'string' } })), undefined, tool);
  }
  for (const tool of [
    'browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_install', 'browser_resize',
    'browser_tabs', 'unknown',
  ]) {
    assert.equal(browserToolPolicy(BROWSER_SERVER, tool, schemaOf({})), undefined, tool);
  }

  const filename = schemaOf({ text: { type: 'string' }, filename: { type: 'string' } }, ['text']);
  const withoutFilename = browserToolPolicy(BROWSER_SERVER, 'browser_snapshot', filename) as SchemaView;
  assert.equal(withoutFilename.properties.filename, undefined);
  assert.deepEqual(withoutFilename.required, ['text']);
  assert.equal(withoutFilename.additionalProperties, false);
  assert.equal(browserToolPolicy(BROWSER_SERVER, 'browser_snapshot', schemaOf({ filename: { type: 'string' } }, ['filename'])), undefined);
  assert.equal(browserToolPolicy(BROWSER_SERVER, 'browser_snapshot', schemaOf({}, 'malformed-required')), undefined);
});

test('screenshot is fixed to the viewport and cannot write a filename', () => {
  const input = schemaOf({
    type: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    filename: { type: 'string' },
    target: { type: 'string' },
    element: { type: 'string' },
    ref: { type: 'string' },
    fullPage: { type: 'boolean' },
    scale: { type: 'string' },
  });
  const filtered = browserToolPolicy(BROWSER_SERVER, 'browser_take_screenshot', input) as SchemaView;
  assert.deepEqual(Object.keys(filtered.properties), ['type', 'scale']);
  assert.equal(filtered.additionalProperties, false);
  assert.equal(browserToolPolicy(BROWSER_SERVER, 'browser_take_screenshot', schemaOf({ ref: { type: 'string' } }, ['ref'])), undefined);
});

test('disables implicit Enter submission and bounds wait time', () => {
  const typeSchema = browserToolPolicy(BROWSER_SERVER, 'browser_type', schemaOf({
    text: { type: 'string' },
    submit: { type: 'boolean', default: true },
  })) as SchemaView;
  assert.deepEqual(typeSchema.properties.submit, { type: 'boolean', default: true, enum: [false] });

  const waitSchema = browserToolPolicy(BROWSER_SERVER, 'browser_wait_for', schemaOf({
    time: { type: 'number', minimum: 1, maximum: 60 },
  })) as SchemaView;
  assert.deepEqual(waitSchema.properties.time, { type: 'number', minimum: 0, maximum: 10 });
});

test('argument assertion rejects unknown tools and path/viewport escape fields', () => {
  assert.throws(() => assertBrowserArguments('browser_run_code_unsafe', {}), (error) => codeOf(error) === 'browser_tool_denied');
  assert.throws(() => assertBrowserArguments('browser_snapshot', { filename: 'result.txt' }), (error) => codeOf(error) === 'browser_arguments_denied');
  assert.doesNotThrow(() => assertBrowserArguments('browser_click', { ref: 'e1' }));
  assert.throws(() => assertBrowserArguments('browser_type', { submit: true }), (error) => codeOf(error) === 'browser_arguments_denied');
  assert.throws(() => assertBrowserArguments('browser_take_screenshot', { fullPage: true }), (error) => codeOf(error) === 'browser_arguments_denied');
  assert.throws(() => assertBrowserArguments('browser_take_screenshot', { target: 'e1' }), (error) => codeOf(error) === 'browser_arguments_denied');
  assert.throws(() => assertBrowserArguments('browser_take_screenshot', { element: 'page' }), (error) => codeOf(error) === 'browser_arguments_denied');
  assert.throws(() => assertBrowserArguments('browser_click', null), (error) => codeOf(error) === 'mcp_arguments_invalid');
});

test('navigation accepts only absolute HTTP(S) URLs without userinfo', () => {
  assert.doesNotThrow(() => assertBrowserArguments('browser_navigate', { url: 'http://localhost:8080/page' }));
  assert.doesNotThrow(() => assertBrowserArguments('browser_navigate', { url: 'https://example.org/search?q=one' }));
  for (const url of [
    'file:///C:/private.txt',
    'ftp://example.org/file',
    'javascript:alert(1)',
    'https://user:pass@example.org/',
    'https://',
    '   ',
    `https://example.org/${'x'.repeat(8_200)}`,
  ]) {
    assert.throws(() => assertBrowserArguments('browser_navigate', { url }), (error) => codeOf(error) === 'browser_url_invalid', url);
  }
});

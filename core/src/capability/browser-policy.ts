import { KernelError } from '../errors.js';

export const BROWSER_SERVER = 'ligule-browser';

const ALLOWED_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_close',
  'browser_handle_dialog',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function browserToolPolicy(server: string, tool: string, inputSchema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (server !== BROWSER_SERVER) return inputSchema;
  if (!ALLOWED_TOOLS.has(tool) || !isRecord(inputSchema.properties)) return undefined;

  const schema = structuredClone(inputSchema);
  const properties = schema.properties as Record<string, unknown>;
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((name) => typeof name !== 'string'))) return undefined;

  const removed = ['filename'];
  if (tool === 'browser_take_screenshot') removed.push('ref', 'target', 'element', 'fullPage');
  if (Array.isArray(required) && required.some((name) => removed.includes(name))) return undefined;
  for (const name of removed) delete properties[name];
  if (Array.isArray(required)) schema.required = required;
  schema.additionalProperties = false;

  if (tool === 'browser_navigate' && isRecord(properties.url)) {
    properties.url = { ...properties.url, maxLength: 8_192 };
  }
  if (tool === 'browser_type' && isRecord(properties.submit)) {
    properties.submit = { ...properties.submit, enum: [false] };
  }
  if (tool === 'browser_wait_for' && isRecord(properties.time)) {
    properties.time = { ...properties.time, minimum: 0, maximum: 10 };
  }
  return schema;
}

export function assertBrowserArguments(tool: string, args: unknown): void {
  if (!ALLOWED_TOOLS.has(tool)) throw new KernelError('browser_tool_denied');
  if (!isRecord(args)) throw new KernelError('mcp_arguments_invalid');
  const deniedProperties = tool === 'browser_take_screenshot'
    ? ['filename', 'ref', 'target', 'element', 'fullPage']
    : ['filename'];
  if (deniedProperties.some((name) => Object.hasOwn(args, name))) {
    throw new KernelError('browser_arguments_denied');
  }
  if (tool === 'browser_type' && args.submit === true) throw new KernelError('browser_arguments_denied');
  if (tool !== 'browser_navigate') return;

  if (typeof args.url !== 'string' || Array.from(args.url).length < 1 || Array.from(args.url).length > 8_192) {
    throw new KernelError('browser_url_invalid');
  }
  let url: URL;
  try { url = new URL(args.url); }
  catch { throw new KernelError('browser_url_invalid'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === ''
    || url.username !== '' || url.password !== '') {
    throw new KernelError('browser_url_invalid');
  }
}

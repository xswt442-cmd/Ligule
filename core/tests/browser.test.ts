import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig } from '../dist/index.js';
import { createBrowserSupport } from '../dist/capability/browser.js';
import type { ConfigSnapshot } from '../dist/kernel/config.js';
import type { SessionDirectoryConfig } from '../dist/session/list.js';
import type { NormalizedMcpServerConfig } from '../dist/capability/mcp.js';

type BrowserTestConfig = ConfigSnapshot & SessionDirectoryConfig;

async function withRoot(run: (root: string) => Promise<void>) {
  await mkdir(join(process.cwd(), 'testplace'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'browser-config-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('missing or project-only browser settings never activate an external backend', async () => {
  await withRoot(async root => {
    const selected = { provider: 'playwright-mcp', entryPoint: '/not-present/cli.js', executablePath: '/not-present/chrome' };
    const config = createConfig({ user: { boundary: root, workspaceRoot: root }, project: { browser: selected } }) as BrowserTestConfig;
    const result = await createBrowserSupport(config, { user: {}, project: { browser: selected } });
    assert.deepEqual(result.status, { configured: false, available: false, code: 'browser_not_configured' });
    assert.equal(result.server, undefined);
    await assert.rejects(result.session('session'), { code: 'browser_not_configured' });
  });
});

test('invalid and missing installed browser dependencies expose a real unavailable diagnostic', async () => {
  await withRoot(async root => {
    const config = (browser: Record<string, unknown>) => createConfig({ user: { boundary: root, browser } }) as BrowserTestConfig;
    const invalid = await createBrowserSupport(config({ provider: 'other', entryPoint: 'relative', executablePath: 'relative' }), {});
    assert.equal(invalid.status.code, 'browser_settings_invalid');
    const missing = await createBrowserSupport(config({ provider: 'playwright-mcp', entryPoint: join(root, 'missing', 'cli.js'), executablePath: join(root, 'missing', 'chrome') }), {});
    assert.equal(missing.status.code, 'browser_backend_unavailable');
    assert.equal(missing.server, undefined);
  });
});

const entryPoint = process.env.LIGULE_PLAYWRIGHT_MCP_ENTRY;
const executablePath = process.env.LIGULE_BROWSER_EXE;
test('an installed backend gets immutable headless configuration, independent storage and one stable trust identity', {
  skip: entryPoint === undefined || executablePath === undefined,
}, async () => {
  await withRoot(async root => {
    const config = createConfig({ user: { boundary: root, workspaceRoot: root,
      browser: { provider: 'playwright-mcp', entryPoint, executablePath } } }) as BrowserTestConfig;
    const support = await createBrowserSupport(config, {});
    assert.deepEqual(support.status, { configured: true, available: true });
    const first = await support.session('owner');
    const child = await support.session('owner.sub-1');
    const output = (server: NormalizedMcpServerConfig) => server.args[server.args.indexOf('--output-dir') + 1];
    assert.notEqual(output(first), output(child));
    assert.equal(first.identityDigest, child.identityDigest);
    const path = first.args[first.args.indexOf('--config') + 1];
    const settings = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(settings.browser.isolated, true);
    assert.equal(settings.browser.launchOptions.headless, true);
    assert.equal(settings.browser.launchOptions.chromiumSandbox, true);
    assert.equal(settings.browser.contextOptions.acceptDownloads, false);
    assert.deepEqual(settings.browser.contextOptions.viewport, { width: 1280, height: 800 });
    await assert.rejects(support.session('../escape'), { code: 'browser_session_invalid' });
    await writeFile(join(output(first), 'transient.txt'), 'real cache output');
    await support.clearSession('owner');
    const retained = await readdir(output(first));
    assert.ok(retained.includes('.ligule-owner.json'));
    assert.ok(retained.includes('.ligule-lease.lock'));
    assert.equal(retained.includes('transient.txt'), false);
    await support.closeSession('owner');
    await assert.rejects(readdir(output(first)), { code: 'ENOENT' });
    await writeFile(path, '{}');
    await assert.rejects(support.verify(), { code: 'browser_configuration_changed' });
    await support.closeSession('owner.sub-1');
  });
});

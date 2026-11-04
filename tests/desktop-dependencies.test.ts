import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const desktopRequire = createRequire(new URL('../desktop/package.json', import.meta.url));
const config = desktopRequire('./electron-builder.cjs');

test('deb declares the Electron graphics and audio libraries alongside the standard runtime dependencies', () => {
  const dependencies = config.deb.depends;
  for (const name of [
    'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6',
    'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libgbm1',
  ]) assert.ok(dependencies.includes(name), `${name} must be installed with the deb`);
  assert.ok(dependencies.includes('libasound2t64 | libasound2'), 'ALSA must support Noble and earlier Debian-family systems');
});

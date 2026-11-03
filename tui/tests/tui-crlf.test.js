import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from '../dist/tui/app.js';
import { readInput, rememberInput } from '../dist/tui/input-store.js';
import { completeFrame } from './helpers/frames.js';
import { waitFor, withTuiHost } from '../../core/tests/helpers/tui-host.ts';

const editorFixture = fileURLToPath(new URL('./fixtures/editor.mjs', import.meta.url));
const quoted = value => `"${value.replaceAll('"', '\\"')}"`;

for (const source of ['saved draft', 'external editor']) {
  test(`${source} normalizes CRLF before vertical movement and Delete`, async () => {
    await withTuiHost(async context => {
      const inputFile = join(context.directory, 'inputs.jsonl');
      if (source === 'saved draft') {
        await rememberInput(inputFile, { projectRoot: context.projectDirectory, sessionId: context.sessionId, draft: 'a\r\nb', queued: [] });
      }
      const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
      let painted = '';
      stdout.on('data', chunk => { painted += chunk; });
      const frame = () => completeFrame(painted);
      const wait = condition => waitFor(condition, { within: 5000, read: frame });
      const instance = render(createElement(App, {
        client: context.client, sessionId: context.sessionId, stdout,
        info: { boundary: context.projectDirectory, editor: `${quoted(process.execPath)} ${quoted(editorFixture)} replace-crlf - - -` },
        inputs: {
          read: (projectRoot, sessionId) => readInput(inputFile, projectRoot, sessionId),
          write: (projectRoot, sessionId, draft, queued) => rememberInput(inputFile, { projectRoot, sessionId, draft, queued }),
        },
      }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true });
      try {
        await wait(() => frame().includes('审批 逐次审批'));
        if (source === 'external editor') stdin.write('\x07');
        await wait(() => frame().includes('› a'));
        stdin.write('\x1b[A');
        await delay(40);
        stdin.write('\x1b[3~');
        await delay(40);
        stdin.write('\r');
        await wait(() => context.providerRequests.length > 0);
        const user = context.providerRequests[0].messages.findLast(message => message.role === 'user');
        assert.equal(user.content, 'ab', 'Delete removes one normalized newline, without leaving an isolated carriage return');
      } finally {
        instance.unmount();
      }
    });
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as callbackExecFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(repositoryRoot, 'testplace', 'tmp');
const childSource = `
import { createConfig, createConnection, createMemoryConnectionPair, providerFromConfig, serveHost } from './dist/index.js';
const reference = process.env.LIGULE_CREDENTIAL_TEST_REFERENCE;
const config = createConfig({ flag: {
  boundary: process.cwd(),
  model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'credential-probe', apiKeyEnv: reference },
  policy: { mode: 'ask' },
} });
const pair = createMemoryConnectionPair();
const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider: providerFromConfig(config), policy: config.policy });
const connection = createConnection(pair.client);
try {
  const { sessionId } = await connection.request('session.create', {});
  await connection.request('run.start', { sessionId, input: 'credential error boundary probe' });
  throw new Error('the run unexpectedly reached the model endpoint');
} catch (error) {
  if (error.code !== 'credential_store_unavailable') throw error;
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message, detail: error.detail }));
} finally {
  pair.client.output.end();
  await host.release();
}
`;

function randomReference() {
  return `LIGULE_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type CredentialFixture = { directory: string; home: string; reference: string };

async function withFixture(run: (state: CredentialFixture) => Promise<void>) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'credential-native-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const previousHome = process.env.LIGULE_HOME;
  const reference = randomReference();
  const previousReference = process.env[reference];
  process.env.LIGULE_HOME = home;
  delete process.env[reference];
  try {
    return await run({ directory, home, reference });
  } finally {
    restoreEnvironment('LIGULE_HOME', previousHome);
    restoreEnvironment(reference, previousReference);
    await rm(directory, { recursive: true, force: true });
  }
}

test('a real Host process hides native loader causes behind the credential error detail', async () => {
  await withFixture(async ({ directory, home, reference }) => {
    const nativePath = join(directory, 'missing-native-binding.node');
    const environment: NodeJS.ProcessEnv = { ...process.env, LIGULE_HOME: home, NAPI_RS_NATIVE_LIBRARY_PATH: nativePath };
    environment.LIGULE_CREDENTIAL_TEST_REFERENCE = reference;
    delete environment[reference];
    let result;
    try {
      result = await execFile(process.execPath, ['--input-type=module', '--eval', childSource], {
        cwd: repositoryRoot,
        env: environment,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error('the real Host process failed before returning its credential error');
    }
    assert.deepEqual(JSON.parse(result.stdout), {
      code: 'credential_store_unavailable',
      message: 'credential_store_unavailable',
      detail: 'the system credential store could not complete the operation',
    });
  });
});

if (process.env.LIGULE_CREDENTIAL_NATIVE_REQUIRED === '1') {
  test('native credentials persist, replace, isolate data roots, and delete', async () => {
    await withFixture(async ({ home, directory, reference }) => {
      const { credentialStatus, deleteCredential, resolveCredential, storeCredential } = await import('../dist/kernel/credentials.js');
      const homeB = join(directory, 'home-b');
      await mkdir(homeB);
      let storedA = false;
      let storedB = false;
      const firstValue = `first-${randomUUID()}`;
      const replacementValue = `replacement-${randomUUID()}`;
      const otherRootValue = `other-root-${randomUUID()}`;
      const assertSecret = (actual: unknown, expected: unknown, message: string) => assert.equal(actual === expected, true, message);
      try {
        assert.equal(await resolveCredential(reference), undefined);
        assert.deepEqual(await credentialStatus(reference), { reference, source: 'missing', configured: false });
        assert.equal(await deleteCredential(reference), false);

        await storeCredential(reference, firstValue);
        storedA = true;
        assertSecret(await resolveCredential(reference), firstValue, 'the first stored value should resolve');
        const child = await execFile(process.execPath, ['tests/fixtures/credential-read.mjs'], {
          cwd: repositoryRoot,
          env: { ...process.env, LIGULE_CREDENTIAL_TEST_REFERENCE: reference, LIGULE_CREDENTIAL_TEST_DIGEST: createHash('sha256').update(firstValue).digest('hex') },
          timeout: 20_000,
        });
        assert.equal(child.stdout.trim(), 'credential persisted');
        assert.deepEqual(await credentialStatus(reference), { reference, source: 'keyring', configured: true });

        process.env.LIGULE_HOME = homeB;
        assert.equal(await resolveCredential(reference), undefined);
        assert.deepEqual(await credentialStatus(reference), { reference, source: 'missing', configured: false });
        await storeCredential(reference, otherRootValue);
        storedB = true;
        assertSecret(await resolveCredential(reference), otherRootValue, 'the second data root should keep its own value');

        process.env.LIGULE_HOME = home;
        await storeCredential(reference, replacementValue);
        assertSecret(await resolveCredential(reference), replacementValue, 'replacement should take effect');
        assert.equal(await deleteCredential(reference), true);
        storedA = false;
        assert.equal(await resolveCredential(reference), undefined);
        assert.equal(await deleteCredential(reference), false);

        process.env.LIGULE_HOME = homeB;
        assertSecret(await resolveCredential(reference), otherRootValue, 'deleting one root should preserve the other');
        assert.equal(await deleteCredential(reference), true);
        storedB = false;
        assert.equal(await resolveCredential(reference), undefined);
      } finally {
        delete process.env[reference];
        if (storedB) {
          process.env.LIGULE_HOME = homeB;
          await deleteCredential(reference);
        }
        if (storedA) {
          process.env.LIGULE_HOME = home;
          await deleteCredential(reference);
        }
      }
    });
  });
}

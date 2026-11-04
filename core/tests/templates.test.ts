// 验证提示模板的查找目录、递归命令名、头部格式和展开方式，
// 记录里同时留着原始那一行与来源摘要，以及各界面画的是人打的那一句话。
// 目录与文件是真临时目录，Host 与提供方请求体走的是那条真内存通道，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MESSAGES_CAPABILITIES, createConfig, createConnection, createMemoryConnectionPair, discoverTemplates,
  expandTemplate, findTemplate, parseInvocation, serveHost, splitArguments, templateDirectories,
} from '../dist/index.js';
import type { TemplateRegistry } from '../dist/kernel/templates.js';
import type { ModelRequest, ProviderEvent } from '../dist/kernel/loop.js';
import type { SessionEvent } from '../dist/session/format.js';
import type { HostOptions } from '../dist/host/host.js';
import { testHostProvider } from './helpers/provider.ts';

type TemplateFixture = {
  root: string;
  directories: ReturnType<typeof templateDirectories>;
  place: (layer: 'project' | 'user', relativePath: string, text: string) => Promise<string>;
  projectRoot: string;
  userHome: string;
};

async function withTemplates(run: (state: TemplateFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-templates-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  try {
    const directories = templateDirectories(projectRoot, userHome);
    const place = async (layer: 'project' | 'user', relativePath: string, text: string) => {
      const target = join(layer === 'project' ? projectRoot : userHome, '.ligule', 'prompts', relativePath);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, text);
      return target;
    };
    return await run({ root, directories, place, projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const head = (description: string, hint?: string) => `---\ndescription: ${description}\n${hint === undefined ? '' : `argument-hint: "${hint}"\n`}---\n`;

test('nested directories become colon names and the project layer wins', async () => {
  await withTemplates(async ({ directories, place }) => {
    await place('project', 'review/security.md', `${head('review one file')}Look at $1 carefully.\n`);
    await place('project', 'git/release/prepare.md', `${head('prepare a release','[notes]')}Notes: $ARGUMENTS\n`);
    await place('user', 'review/security.md', `${head('the user copy that loses')}ignored\n`);
    await place('user', 'standup.md', `${head('write a standup')}Today I did $ARGUMENTS\n`);
    const registry = await discoverTemplates(directories);
    assert.deepEqual(registry.templates.map((template) => template.command), ['git:release:prepare', 'review:security', 'standup']);
    // 同名模板按目录优先级选择，并能报告胜出和被覆盖模板的位置。
    const kept = registry.templates.find((template) => template.command === 'review:security')!;
    assert.equal(kept.description, 'review one file');
    assert.equal(kept.layer, 'project');
    assert.deepEqual(registry.diagnostics.map((item) => item.code), ['template_name_conflict']);
    assert.match(registry.diagnostics[0].detail, /the loaded one is .*project[\\/]\.ligule[\\/]prompts/);
    // argument-hint 是给人看的那一句提示，可选，形状错了要报出来。
    assert.equal(kept.hint, undefined);
    assert.equal(registry.templates.find((template) => template.command === 'git:release:prepare')!.hint, '[notes]');
  });
});

test('a header or a path segment that cannot be used is reported instead of quietly dropped', async () => {
  await withTemplates(async ({ directories, place }) => {
    await place('project', 'nohead.md', 'just text\n');
    await place('project', 'nodescription.md', '---\nargument-hint: "[x]"\n---\nbody\n');
    await place('project', 'Bad/broken.md', `${head('a name nobody can type')}body\n`);
    await place('project', 'hint.md', '---\ndescription: a hint of the wrong shape\nargument-hint: 42\n---\nbody\n');
    await place('project', 'long.md', `${head('d'.repeat(1100))}body\n`);
    const registry = await discoverTemplates(directories);
    assert.deepEqual(registry.templates, []);
    assert.deepEqual(registry.diagnostics.map((item) => item.code).sort(), [
      'template_command_invalid', 'template_description_missing', 'template_description_too_long',
      'template_frontmatter_missing', 'template_hint_invalid',
    ]);
  });
});

test('only a shape that could be a command is treated as an invocation', () => {
  assert.deepEqual(parseInvocation('/review:security src/a.ts "and notes"'), { command: 'review:security', arguments: 'src/a.ts "and notes"' });
  assert.deepEqual(parseInvocation('/standup'), { command: 'standup', arguments: '' });
  // 路径、带点的名字与行首有空格的都不算调用：那些是人真的要说的那句话。
  for (const text of ['/etc/hosts has a line', 'note.txt is short', '/ Bad thing', '//double', 'Revise this', '/review.v2 x']) {
    assert.equal(parseInvocation(text), undefined, text);
  }
});

test('arguments split on shell quoting and an unbalanced quote is refused', () => {
  assert.deepEqual(splitArguments('src/a.ts "API compatibility" \'two words\''), ['src/a.ts', 'API compatibility', 'two words']);
  assert.deepEqual(splitArguments(''), []);
  assert.equal(splitArguments('"open" closed').length, 2);
  // 引号不成对当场抛出去，而不是交回一个把后半截吞掉的参数表。
  assert.equal((() => {
    try {
      splitArguments('"open');
    } catch (failure) {
      return (failure as { code: string }).code;
    }
    throw new Error('splitArguments should have refused');
  })(), 'template_arguments_unbalanced');
});

test('an unknown command names what is loaded instead of failing quietly', async () => {
  await withTemplates(async ({ directories, place }) => {
    await place('project', 'review.md', `${head('review one file')}body\n`);
    const registry = await discoverTemplates(directories);
    const error = (() => {
      try {
        findTemplate(registry, 'revew');
      } catch (failure) {
        return failure as { code: string; detail: string };
      }
      throw new Error('findTemplate should have refused');
    })();
    assert.equal(error.code, 'template_unknown');
    assert.match(error.detail, /\/review/);
  });
});

test('the two placeholder forms expand and everything else stays as written', async () => {
  await withTemplates(async ({ directories, place }) => {
    const all = await place('project', 'all.md', `${head('all of them')}Run: $ARGUMENTS\n`);
    const first = await place('project', 'first.md', `${head('one position')}Target: $1 twice: $1\n`);
    const plain = await place('project', 'plain.md', `${head('no placeholder at all')}Fixed text.\n`);
    const registry: TemplateRegistry = await discoverTemplates(directories);
    const templateOf = (command: string) => registry.templates.find((template) => template.command === command)!;

    const expanded = await expandTemplate(templateOf('all'), '"two things" and more');
    assert.equal(expanded.text, 'Run: two things and more\n');
    assert.deepEqual(expanded.arguments, ['two things', 'and', 'more']);
    assert.equal(expanded.source, all);
    assert.match(expanded.digest, /^[0-9a-f]{12}$/);

    // 参数里带一个占位写法不会被第二次替换吃掉，缺的位置交回空串。
    const positional = await expandTemplate(templateOf('first'), '$2');
    assert.equal(positional.text, 'Target: $2 twice: $2\n');
    assert.equal((await expandTemplate(templateOf('first'), '')).text, 'Target:  twice: \n');

    // 模板里一个占位都没有而人带了参数：那几句话不能丢，接在正文之后。
    const appended = await expandTemplate(templateOf('plain'), 'the user words');
    assert.equal(appended.text, 'Fixed text.\n\nthe user words\n');
    assert.equal((await expandTemplate(templateOf('plain'), '')).text, 'Fixed text.\n');
    // 改了模板文件就换摘要：这是记录里看得出「用的哪一版」的那一格。
    await writeFile(plain, `${head('no placeholder at all')}Fixed text, edited.\n`);
    const reread = await discoverTemplates(directories);
    const changed = await expandTemplate(reread.templates.find((template) => template.command === 'plain')!, '');
    assert.notEqual(changed.digest, appended.digest);
  });
});

test('the Host expands before the loop and the record keeps both that line and the expansion', async () => {
  await withTemplates(async ({ place, projectRoot, userHome }) => {
    await place('project', 'review/security.md', `${head('review one file')}Review $1\n`);
    const registry = await discoverTemplates(templateDirectories(projectRoot, userHome));
    const config = createConfig({
      user: {
        boundary: projectRoot,
        model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
        policy: { mode: 'ask' },
      },
    });
    const requests: ModelRequest[] = [];
    const provider = testHostProvider({
      capabilities: MESSAGES_CAPABILITIES,
      model: 'test-model',
      async *stream(request: ModelRequest): AsyncGenerator<ProviderEvent> {
        requests.push(request);
        // 循环消费提供方返回的标准事件；此处只生成文本事件。
        yield { type: 'text', text: 'ok' };
      },
    });
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy as HostOptions['policy'], templateRegistry: registry,
    });
    const connection = createConnection(pair.client);
    const seen: Record<string, unknown>[] = [];
    connection.onNotification((message) => {
      if (message.notify === 'event') seen.push(message.event as Record<string, unknown>);
    });
    try {
      const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
      const result = await connection.request('run.start', { sessionId, input: '/review:security src/a.ts "API notes"' }) as { text: string };
      assert.equal(result.text, 'ok');
      // 模型看见的是展开后的那一份。
      assert.deepEqual(requests[0].messages.at(-1), { role: 'user', text: 'Review src/a.ts\n' });
      // 模板展开信息完整写入记录，但事件仍保持普通用户消息类型。
      const { events } = await connection.request('session.read', { sessionId }) as { events: SessionEvent[] };
      const user = events.find((event) => event.kind === 'user')!;
      assert.equal(user.raw, '/review:security src/a.ts "API notes"');
      assert.equal(user.text, 'Review src/a.ts\n');
      assert.deepEqual(user.arguments, ['src/a.ts', 'API notes']);
      assert.match(user.source as string, /review[\\/]security\.md$/);
      assert.match(user.digest as string, /^[0-9a-f]{12}$/);
      // 推给客户端的那一条也是原始那一行：界面上回声要等于人打的字。
      assert.equal(seen.find((event) => event.kind === 'user')!.raw, '/review:security src/a.ts "API notes"');

      // 查不到的那一条斜杠在这一侧就报出去，不带着没展开的原文进模型，也不留一条用户记录。
      const before = ((await connection.request('session.read', { sessionId })) as { events: unknown[] }).events.length;
      const failure = await connection.request('run.start', { sessionId, input: '/review:securityy x' }).catch((error) => error) as { code: string };
      assert.equal(failure.code, 'template_unknown');
      assert.equal(requests.length, 1);
      assert.equal(((await connection.request('session.read', { sessionId })) as { events: unknown[] }).events.length, before);
    } finally {
      pair.client.output.end();
      host.release();
    }
  });
});

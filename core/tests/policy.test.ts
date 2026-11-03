import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createDecisionChain, createKernel, KernelError } from '../dist/index.js';
import { policyArgsHash } from '../dist/kernel/policy.js';
import type { DecisionChain, PolicyCall, PolicyMode, PolicyQuestion } from '../dist/kernel/policy.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { classifyDangerousCommand } from '../dist/capability/dangerous-command.js';
import type { ShellKind, ShellSelection } from '../dist/capability/shell.js';
import type { NetworkTarget } from '../dist/capability/network.js';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

// 判定结果还包含能力名称、审批档位和所用的决策路径。本文件关注规则顺序与结论。
async function judged(chain: DecisionChain, call: PolicyCall) {
  const { capability, level, via, forced, rule, answer, ...rest } = await chain.evaluate(call);
  return rest;
}

function asked(...answers: boolean[]) {
  const calls: PolicyQuestion[] = [];
  let next = 0;
  return {
    calls,
    ask: async (call: PolicyQuestion) => {
      calls.push(call);
      return answers[next++] ?? false;
    },
  };
}

test('a denied call never reaches the user', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'deleting through exec is not allowed' }],
    ask,
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'rm -rf /tmp/x' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'deleting through exec is not allowed',
  });
  assert.equal(calls.length, 0);
});

test('an asked call follows the answer, and a missing channel denies', async () => {
  const yes = asked(true);
  assert.deepEqual(await judged(createDecisionChain({ ask: yes.ask }), { tool: 'read', input: {} }), { decision: 'allow' });
  assert.deepEqual(yes.calls, [{ tool: 'read', input: {}, command: undefined, reason: undefined, policy: 'ask', policySource: 'config', policyForced: false, rememberable: true }]);

  const no = asked(false);
  assert.equal((await createDecisionChain({ ask: no.ask }).evaluate({ tool: 'read', input: {} })).code, 'ask_declined');
  assert.equal((await createDecisionChain({}).evaluate({ tool: 'read', input: {} })).code, 'ask_unavailable');
});

test('remembered file allows match one file by path and workspace rules stay scoped to one operation', async () => {
  const root = process.cwd();
  const chain = createDecisionChain({ mode: 'ask', rules: [
    { tool: 'create', decision: 'allow', target: 'file', path: `${root}/phase6-remembered.ts` },
    { tool: 'write', decision: 'allow', target: 'workspace', path: root },
  ], ask: async () => false });
  const common = { access: 'write', fileBoundary: root, workingDirectory: root } as const;
  const exact = await chain.evaluate({ tool: 'create', input: { path: 'phase6-remembered.ts', content: 'ok' }, ...common });
  const sibling = await chain.evaluate({ tool: 'create', input: { path: 'other.ts', content: 'ok' }, ...common });
  const workspaceWrite = await chain.evaluate({ tool: 'write', input: { path: 'other.ts', content: 'ok' }, ...common });
  assert.equal(exact.via, 'rules');
  assert.equal(sibling.code, 'ask_declined');
  assert.equal(workspaceWrite.via, 'rules');
});

test('remembered MCP allows bind arguments and the current server configuration digest', async () => {
  const args = { server: 'playwright', tool: 'click', arguments: '{"selector":"#save"}', schemaDigest: 'schema-1' };
  const chain = createDecisionChain({ mode: 'ask', rules: [{
    tool: 'mcp:playwright/click', decision: 'allow', argsHash: policyArgsHash(args, 'config-1'),
  }], ask: async () => false });
  const approved = await chain.evaluate({ tool: 'mcp.call', capability: 'mcp:playwright/click', input: args, identityDigest: 'config-1' });
  const changedArgs = await chain.evaluate({ tool: 'mcp.call', capability: 'mcp:playwright/click', input: { ...args, arguments: '{"selector":"#delete"}' }, identityDigest: 'config-1' });
  const changedConfig = await chain.evaluate({ tool: 'mcp.call', capability: 'mcp:playwright/click', input: args, identityDigest: 'config-2' });
  assert.equal(approved.via, 'rules');
  assert.equal(changedArgs.code, 'ask_declined');
  assert.equal(changedConfig.code, 'ask_declined');
});

test('a failed remembered approval returns its stable persistence failure instead of allowing once', async () => {
  const chain = createDecisionChain({ ask: async () => ({
    decision: 'deny',
    code: 'config_version_stale',
    reason: 'the remembered rule was not saved',
  }) });
  const result = await chain.evaluate({ tool: 'read', input: {} });
  assert.equal(result.decision, 'deny');
  assert.equal(result.code, 'config_version_stale');
  assert.equal(result.reason, 'the remembered rule was not saved');
});

// 审批请求携带发起会话自身的档位和来源，避免界面查看其他会话时显示错误的审批依据，
// 也不能把「被连着拒绝压下来」说成「配置文件里写着逐次询问」。
test('the question names the tier and the source of the chain that asked', async () => {
  const plain = asked(true);
  await judged(createDecisionChain({ ask: plain.ask }), { tool: 'read', input: {} });
  assert.deepEqual(plain.calls.map((call) => [call.policy, call.policySource, call.policyForced]), [['ask', 'config', false]],
    '默认那一档问过来的：档位与来源都说得出');

  const session = asked(true);
  const overridden = createDecisionChain({ mode: 'auto', ask: session.ask });
  overridden.setMode('ask');
  await judged(overridden, { tool: 'read', input: {} });
  assert.deepEqual(session.calls.map((call) => [call.policy, call.policySource, call.policyForced]), [['ask', 'session', false]],
    '这一条问过来时它走的是这一份会话自己改过的那一档');

  const forced = asked(true);
  const falling = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 2, total: 99 }, ask: forced.ask });
  falling.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  await falling.evaluate({ tool: 'exec', input: { command: 'rm' } });
  await falling.evaluate({ tool: 'exec', input: { command: 'rm' } });
  assert.equal(falling.mode, 'ask', '连着拒掉两次之后这一档被压到逐次询问');
  await judged(falling, { tool: 'exec', input: { command: 'ls' } });
  assert.deepEqual(forced.calls.map((call) => [call.policy, call.policySource, call.policyForced]), [['ask', 'config', true]],
    '压下来那一次说的是这一档被压下来了，来源仍是配置那一份默认');
});

test('a later guard cannot undo an earlier denial', async () => {  const chain = createDecisionChain({ ask: async () => true });
  chain.guard(() => 'first guard says no');
  chain.guard(() => undefined);
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls' } }), {
    decision: 'deny',
    code: 'guard_denied',
    reason: 'first guard says no',
  });
});

test('no-approval mode skips ordinary approval while deny rules, guards, and unsafe targets remain closed', async () => {
  let asked = 0;
  const chain = createDecisionChain({
    mode: 'none',
    ask: async () => { asked += 1; return true; },
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'blocked by rule' }],
  });
  chain.guard(({ command }) => command?.startsWith('curl ') === true ? 'blocked by guard' : undefined);

  assert.equal((await chain.evaluate({ tool: 'read', input: { path: 'README.md' } })).via, 'none');
  assert.equal((await chain.evaluate({ tool: 'create', input: { path: 'new.txt', content: 'ok' } })).via, 'none');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'git status --short' } })).via, 'none');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm -rf target' } })).code, 'policy_denied');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'curl https://example.com' } })).code, 'guard_denied');
  assert.equal((await chain.evaluate({ tool: 'read', input: { path: 'x' }, target: { class: 'private', addresses: ['10.0.0.2'] } as unknown as NetworkTarget })).code, 'policy_manual_approval_disabled');
  assert.equal(asked, 0);
});

test('no-approval mode does not turn repeated denials into approval prompts', async () => {
  let asked = 0;
  const chain = createDecisionChain({ mode: 'none', thresholds: { consecutive: 1, total: 1 }, ask: async () => { asked += 1; return true; } });
  chain.guard(({ command }) => command === 'blocked' ? 'blocked by guard' : undefined);
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'blocked' } })).decision, 'deny');
  assert.equal(chain.mode, 'none');
  assert.equal((await chain.evaluate({ tool: 'read', input: { path: 'README.md' } })).via, 'none');
  assert.equal(asked, 0);
});

test('legacy never retains its refusal for file operations that require approval', async () => {
  let asked = 0;
  const chain = createDecisionChain({ mode: 'never', ask: async () => { asked += 1; return true; } });
  const result = await chain.evaluate({ tool: 'create', input: { path: 'new.txt', content: 'blocked' } });
  assert.equal(result.decision, 'deny');
  assert.equal(result.code, 'policy_denied');
  assert.equal(result.via, 'never');
  assert.equal(asked, 0);
});

test('auto policy requires manual approval for external and unclassified tools even when an allow rule matches', async () => {
  for (const access of ['external', 'unknown'] as const) {
    const { calls, ask } = asked(true);
    const chain = createDecisionChain({
      mode: 'auto',
      rules: [{ tool: 'mcp:fs/remove', decision: 'allow', match: '*' }],
      ask,
    });
    const result = await chain.evaluate({
      tool: 'mcp.call', capability: 'mcp:fs/remove', access, input: { arguments: '{}' },
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.via, 'ask');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'mcp:fs/remove');
    assert.match(calls[0].reason!, /external process|permission classification/u);
  }

  let askedCount = 0;
  const never = createDecisionChain({ mode: 'never', ask: async () => { askedCount += 1; return true; } });
  const refused = await never.evaluate({ tool: 'mcp.call', capability: 'mcp:fs/remove', access: 'external', input: {} });
  assert.equal(refused.decision, 'deny');
  assert.equal(refused.code, 'policy_denied');
  assert.equal(askedCount, 0);
});

test('a deny rule wins over an allow rule written earlier in the table', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({
    rules: [
      { tool: 'exec', decision: 'allow', match: 'git *' },
      { tool: 'exec', decision: 'deny', match: 'git push *', reason: 'pushing is the host call' },
    ],
    ask,
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git push origin main' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'pushing is the host call',
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.equal(calls.length, 0);
});

test('a matching ask rule requires approval even when the session would otherwise auto-allow', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({
    mode: 'never',
    rules: [
      { tool: 'mcp:playwright/browser_navigate', decision: 'allow' },
      { tool: 'mcp:playwright/browser_navigate', decision: 'ask', reason: 'review browser navigation' },
    ],
    ask,
  });

  const result = await chain.evaluate({
    tool: 'mcp.call', capability: 'mcp:playwright/browser_navigate', input: { url: 'https://example.com' },
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.via, 'ask');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'review browser navigation');
});

test('every segment of a pipeline has to be covered before an asked call is allowed', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }], ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status | grep x' } }), { decision: 'allow', segments: ['git status', 'grep x'] });
  assert.equal(calls.length, 1, 'only the pipeline needed a decision');
  assert.equal(calls[0].command, 'git status | grep x');
  assert.equal(calls[0].reason, undefined);

  // 多条放行规则不能拼接成一条完整许可；无法指出匹配规则时应继续询问用户。
  const second = asked(true);
  const across = createDecisionChain({
    rules: [{ tool: 'exec', decision: 'allow', match: 'git status' }, { tool: 'exec', decision: 'allow', match: 'grep x' }],
    ask: second.ask,
  });
  const wide = await across.evaluate({ tool: 'exec', input: { command: 'git status | grep x' } });
  assert.equal(wide.via, 'ask');
  assert.equal(wide.decision, 'allow', '人点头之后才放行：这一条链上没有一条规则盖住两段');
  assert.equal(second.calls.length, 1);
});

test('a deny rule catches a segment hidden behind a pipe', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }], ask });
  assert.equal(
    (await chain.evaluate({ tool: 'exec', input: { command: 'git status | rm -rf /tmp/x' } })).code,
    'policy_denied',
  );
  assert.equal(calls.length, 0);
});

test('hard denied commands remain denied across modes, allow rules, and affirmative asks', async () => {
  const encodedRemoval = Buffer.from('Remove-Item -Path "$env:USERPROFILE\\*" -Recurse -Force', 'utf16le').toString('base64');
  const commands: [ShellKind, string][] = [
    ['bash', 'rm -rf ~'],
    ['bash', "'rm' -rf /"],
    ['bash', '"rm" -rf /'],
    ['bash', 'r""m -rf /'],
    ['bash', String.raw`r\m -rf /`],
    ['bash', String.raw`$'rm' -rf /`],
    ['bash', String.raw`$'r\x6d' -rf /`],
    ['bash', String.raw`$'r\155' -rf /`],
    ['bash', String.raw`rm -rf $'\x2f'`],
    ['bash', String.raw`rm -rf $'\057'`],
    ['bash', String.raw`rm -rf /home\/alice`],
    ['bash', '$(rm -rf ~)'],
    ['bash', 'rm -rf /*'],
    ['bash', 'sudo env APP_MODE=test command exec bash -c "rm -rf ~/*"'],
    ['bash', 'sudo -u builder env -u TMPDIR rm -rf ~'],
    ['bash', "sh -c 'find /home/* -type f -delete'"],
    ['bash', 'command env taskkill /IM python.exe /F'],
    ['bash', '/bin/rm --recursive --force /'],
    ['bash', 'sudo /usr/bin/rm -fr "$HOME"'],
    ['bash', 'echo ready; env /bin/rm -rf /home'],
    ['bash', 'find / -type f -delete'],
    ['bash', String.raw`find . -exec rm -rf ~ \;`],
    ['bash', String.raw`find . -execdir sh -c 'rm -rf ~' \;`],
    ['bash', String.raw`find / -type f -exec rm -f {} +`],
    ['bash', 'xargs rm -rf ~'],
    ['bash', 'cd /home/tester && rm -rf ./*'],
    ['bash', 'cd /home/tester/project && cd .. && rm -rf ./*'],
    ['bash', 'cd / && find . -type f -delete'],
    ['bash', 'bash -c "echo $(rm -rf ~)"'],
    ['bash', String.raw`bash -c "rm -rf \"$HOME\"/*"`],
    ['bash', 'su -c "rm -rf ~"'],
    ['bash', 'pwsh -Command "Remove-Item -Path $env:USERPROFILE\\* -Recurse -Force"'],
    ['bash', `pwsh -enc ${encodedRemoval}`],
    ['powershell', 'pwsh -c "Remove-Item -Path C:\\* -Recurse -Force"'],
    ['powershell', 'Remove-Item -Path $HOME -Recurse -Force'],
    ['powershell', 'Remove-Item -Path "$env:USERPROFILE\\*" -Recurse -Force'],
    ['powershell', 'Remove-Item -Path C:\\* -Recurse -Force'],
    ['powershell', 'ri $env:USERPROFILE -Force -Recurse'],
    ['powershell', 'Remove-Item -Recurse -Force "C:\\Users\\tester"'],
    ['bash', 'bash -c "rm -rf ~ | echo x"'],
    ['powershell', 'pwsh -Command "Remove-Item -Path \'C:\\*\' -Recurse -Force"'],
    ['powershell', 'Write-Output ready; Remove-Item $HOME -Recurse -Force'],
    ['bash', 'pkill -f python'],
    ['bash', 'pkill -f .'],
    ['bash', 'kill -KILL -1'],
    ['bash', 'kill -9 0'],
    ['bash', 'killall -u alice -f .*'],
    ['bash', '/usr/bin/killall python3'],
    ['powershell', 'Stop-Process -Name python -Force'],
    ['powershell', 'Stop-Process -Name * -Force'],
    ['powershell', 'taskkill /IM python.exe /F'],
    ['powershell', 'taskkill /IM * /F'],
  ];
  for (const mode of ['ask', 'auto', 'never'] as const) {
    const { calls, ask } = asked(...commands.map(() => true));
    const chain = createDecisionChain({
      mode,
      ask,
      rules: [{ tool: 'exec', decision: 'allow', match: '*' }],
    });
    for (const [kind, command] of commands) {
      const result = await chain.evaluate({ tool: 'exec', input: { command }, shell: { ...POWERSHELL, kind } });
      assert.deepEqual({ decision: result.decision, via: result.via, forced: result.forced, code: result.code }, {
        decision: 'deny', via: 'hard-deny', forced: true, code: 'policy_hard_denied',
      }, `${mode}: ${command}`);
      assert.equal(typeof result.reason, 'string');
    }
    assert.equal(calls.length, 0, `${mode} never asks a user to approve a hard denied command`);
  }
});

test('the dangerous-command parser follows known wrappers and safe PowerShell encoding', async () => {
  const encodedScript = Buffer.from("Remove-Item -Path 'C:\\*' -Recurse -Force", 'utf16le').toString('base64');
  const commands: [ShellKind, string][] = [
    ['bash', 'sudo env APP_MODE=test command exec bash -c "rm -rf ~/*"'],
    ['bash', 'sudo -u builder env -u TMPDIR rm -rf ~'],
    ['bash', 'bash -c "rm -rf ~ | echo x"'],
    ['bash', 'rm -rf /*'],
    ['bash', "sh -c 'find /home/* -type f -delete'"],
    ['powershell', 'Remove-Item -Path \'C:\\*\' -Recurse -Force'],
    ['bash', 'pwsh -Command "Remove-Item -Path \'C:\\*\' -Recurse -Force"'],
    ['bash', `powershell.exe -EncodedCommand ${encodedScript}`],
  ];
  for (const [kind, command] of commands) {
    const match = await classifyDangerousCommand(command, kind);
    assert.equal(typeof match?.reason, 'string', `${kind}: ${command}`);
  }

  const scopedCleanup: [ShellKind, string][] = [
    ['bash', 'bash -c "rm -rf ~/project/dist"'],
    ['bash', 'rm -rf $HOME/project/dist'],
    ['bash', String.raw`rm -rf /tmp/x\ y`],
    ['bash', String.raw`rm -rf \~`],
    ['powershell', 'pwsh -Command "Remove-Item -Path $HOME\\project\\dist -Recurse -Force"'],
  ];
  for (const [kind, command] of scopedCleanup) {
    assert.equal((await classifyDangerousCommand(command, kind))?.kind, 'approval', `${kind}: ${command}`);
  }
  assert.equal((await classifyDangerousCommand(`rm -rf "${homedir()}/*"`, 'bash'))?.kind, 'hard-deny');
  assert.equal(await classifyDangerousCommand('echo rm -rf ~', 'bash'), undefined);
  assert.equal(await classifyDangerousCommand('printf pkill -f python', 'bash'), undefined);
});

test('an undecodable PowerShell command is not classified as a hard denial', async () => {
  assert.equal((await classifyDangerousCommand('pwsh -EncodedCommand not-base64', 'bash'))?.kind, 'approval');
});

test('an undecodable Bash ANSI-C command remains approval-gated', async () => {
  for (const command of [String.raw`$'r\q' -rf /`, String.raw`$'rm\x' -rf /`]) {
    assert.equal((await classifyDangerousCommand(command, 'bash'))?.kind, 'approval', command);
  }
});

test('ordinary workspace cleanup and unrelated process operations are not hard denied', async () => {
  const commands: [ShellKind, string][] = [
    ['bash', 'rm -rf ./dist'],
    ['bash', 'rm -rf ~/project/dist'],
    ['bash', 'find ./build -type f -delete'],
    ['bash', 'pkill -f node'],
    ['powershell', 'Remove-Item -Path .\\dist -Recurse -Force'],
    ['powershell', 'Remove-Item -Path "$HOME\\project\\dist" -Recurse -Force'],
    ['powershell', 'Stop-Process -Id 1234 -Force'],
  ];
  const { calls, ask } = asked(...commands.map(() => true));
  const chain = createDecisionChain({ mode: 'ask', ask });
  for (const [kind, command] of commands) {
    const result = await chain.evaluate({ tool: 'exec', input: { command }, shell: { ...POWERSHELL, kind } });
    assert.equal(result.decision, 'allow', command);
    assert.equal(result.via, 'ask', command);
  }
  assert.equal(calls.length, commands.length);
});

test('confirmed dangerous operations in wrapper arguments remain hard denied', async () => {
  const commands = [
    'mystery-wrapper rm -rf ~',
    'mystery-wrapper bash -c "rm -rf ~/*"',
    'mystery-wrapper pkill -f python',
  ];
  for (const mode of ['ask', 'auto', 'never'] as const) {
    const { calls, ask } = asked(...commands.map(() => true));
    const chain = createDecisionChain({
      mode,
      ask,
      rules: [{ tool: 'exec', decision: 'allow', match: '*' }],
    });
    for (const command of commands) {
      const result = await chain.evaluate({ tool: 'exec', input: { command } });
      assert.equal(result.decision, 'deny', `${mode}: ${command}`);
      assert.equal(result.via, 'hard-deny', `${mode}: ${command}`);
      assert.equal(result.code, 'policy_hard_denied', `${mode}: ${command}`);
    }
    assert.equal(calls.length, 0, `${mode} cannot approve an identified hard-denied operation`);
  }
});

test('scoped deletions and single-process termination require approval in automatic mode', async () => {
  const commands: [ShellKind, string][] = [
    ['bash', 'rm -rf ./dist'],
    ['bash', 'find ./build -type f -delete'],
    ['bash', String.raw`find ./build -exec rm -rf ./dist \;`],
    ['bash', String.raw`find ./build -exec echo rm -rf ~ \;`],
    ['bash', 'kill 1234'],
    ['powershell', 'Stop-Process -Id 1234 -Force'],
    ['powershell', 'taskkill /PID 1234 /F'],
  ];
  for (const mode of ['ask', 'auto', 'never'] as const) {
    const { calls, ask } = asked(...commands.map(() => true));
    const chain = createDecisionChain({
      mode,
      ask,
      rules: [{ tool: 'exec', decision: 'allow', match: '*' }],
    });
    for (const [kind, command] of commands) {
      const result = await chain.evaluate({ tool: 'exec', input: { command }, shell: { ...POWERSHELL, kind } });
      if (mode === 'never') {
        assert.equal(result.decision, 'deny', `${command} must remain denied without an approval channel`);
        assert.equal(result.via, 'never');
      } else {
        assert.equal(result.decision, 'allow', `${command} requires the affirmative per-call answer`);
        assert.equal(result.via, 'ask');
      }
    }
    assert.equal(calls.length, mode === 'never' ? 0 : commands.length);
  }
});

test('script runners and direct script paths cannot pass automatic approval', async () => {
  const commands: [ShellKind, string][] = [
    ['bash', 'npm run build'],
    ['bash', 'pnpm test'],
    ['bash', 'yarn build'],
    ['bash', 'npx some-tool'],
    ['bash', 'make all'],
    ['bash', `awk 'BEGIN { system("rm -rf ~") }'`],
    ['bash', './scripts/check.sh'],
    ['powershell', '.\\scripts\\check.ps1'],
  ];
  const { calls, ask } = asked(...commands.map(() => true));
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow', match: '*' }] });
  for (const [kind, command] of commands) {
    const result = await chain.evaluate({ tool: 'exec', input: { command }, shell: { ...POWERSHELL, kind } });
    assert.equal(result.decision, 'allow', `${command} needs the affirmative per-call answer`);
    assert.equal(result.via, 'ask', command);
  }
  assert.equal(calls.length, commands.length);
});

test('Git commands that may run hooks require approval even under automatic policy', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow', match: '*' }] });
  const result = await chain.evaluate({
    tool: 'exec', input: { command: 'git add -- file.txt' }, shell: POWERSHELL, requiresManualApproval: true,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.via, 'ask');
  assert.equal(calls.length, 1);
});

test('automatic approval uses the decoded Bash executable name', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask });
  const result = await chain.evaluate({ tool: 'exec', input: { command: 'b""ash -c "echo ready"' } });
  assert.equal(result.decision, 'allow');
  assert.equal(result.via, 'ask');
  assert.equal(calls.length, 1);
});

test('find execution callbacks inspect only the parsed executable position', async () => {
  const { calls, ask } = asked(true, true, true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow', match: '*' }] });
  const echoCallback = await chain.evaluate({ tool: 'exec', input: { command: String.raw`find . -exec echo rm -rf ~ \;` } });
  assert.equal(echoCallback.decision, 'allow');
  assert.equal(echoCallback.via, 'ask');

  const xargsEcho = await chain.evaluate({ tool: 'exec', input: { command: 'xargs echo rm -rf ~' } });
  assert.equal(xargsEcho.decision, 'allow');
  assert.equal(xargsEcho.via, 'ask');

  const awkProgram = await chain.evaluate({ tool: 'exec', input: { command: `awk 'BEGIN { system("rm -rf ~") }'` } });
  assert.equal(awkProgram.decision, 'allow');
  assert.equal(awkProgram.via, 'ask', 'embedded awk programs remain unparsed and cannot pass auto approval');
  assert.equal(calls.length, 3);
});

test('directory changes are followed for broad relative deletion and pipelines do not change the parent directory', async () => {
  const chain = createDecisionChain({ mode: 'auto', ask: async () => true });
  const homeDeletion = await chain.evaluate({ tool: 'exec', input: { command: 'cd /home/alice && rm -rf ./*' } });
  assert.equal(homeDeletion.via, 'hard-deny');
  assert.equal(homeDeletion.code, 'policy_hard_denied');

  const rootDeletion = await chain.evaluate({ tool: 'exec', input: { command: 'Set-Location C:\\Users\\alice; Remove-Item * -Recurse -Force' }, shell: POWERSHELL });
  assert.equal(rootDeletion.via, 'hard-deny');

  const pipeline = await chain.evaluate({ tool: 'exec', input: { command: 'cd /home/alice | rm -rf ./*' } });
  assert.equal(pipeline.via, 'ask');
  assert.equal(pipeline.decision, 'allow');
});

test('a command the parser cannot fully understand is asked about, with the reason', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls -la' } }), { decision: 'allow', segments: ['ls -la'] });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'echo $(whoami)' } })).decision, 'allow');
  assert.equal(calls.length, 1, 'the automatic mode does not approve what it cannot parse');
  assert.match(calls[0].reason!, /command_substitution/);
});

test('content checks still deny in the low-risk automatic mode', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow' }] });
  chain.guard(({ command }) => (command?.includes('curl') ? 'network access is not allowed' : undefined));
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'curl example.com' } })).code, 'guard_denied');
  assert.equal(calls.length, 0);
});

test('the automatic mode lets an ordinary call through and still asks for an interpreter', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow', match: 'python *' }] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls -la' } }), { decision: 'allow', segments: ['ls -la'] });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'python run.py' } })).decision, 'allow');
  assert.deepEqual(calls.map((call) => call.command), ['python run.py']);
});

test('a prefix rule matches whole arguments only, a wildcard rule matches across the rest', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git status' }], ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git statusfoo' } }), { decision: 'allow', segments: ['git statusfoo'] });
  assert.deepEqual(calls.map((call) => call.command), ['git statusfoo']);

  const wild = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }], ask: asked().ask });
  assert.deepEqual(await judged(wild, { tool: 'exec', input: { command: 'git commit -m x' } }), { decision: 'allow', segments: ['git commit -m x'] });
  assert.equal((await wild.evaluate({ tool: 'exec', input: { command: 'github push' } })).code, 'ask_declined');
});

test('a rule with a pattern cannot cover a call that carries no command text', async () => {
  // 匹配的是命令文本，参数里的路径不参与：读文件那一类调用没有命令文本，
  // 填了字的规则对它是「比不了」而不是「比不过」，只有留空的那一条盖得住。
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'read', decision: 'allow', match: 'src/' }], ask });
  assert.equal((await chain.evaluate({ tool: 'read', input: { path: 'src/a.js' } })).answer, 'allow');
  assert.deepEqual(calls.map((call) => call.input), [{ path: 'src/a.js' }], '问过人才放行：这一条规则没有盖住它');

  const blank = createDecisionChain({ rules: [{ tool: 'read', decision: 'allow' }], ask: asked().ask });
  assert.deepEqual(await judged(blank, { tool: 'read', input: { path: 'src/a.js' } }), { decision: 'allow' }, '留空的那一条盖住每一次调用');
});

test('consecutive denials fall back to asking every time', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 2, total: 99 }, ask });
  chain.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal(chain.mode, 'ask');
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls' } }), { decision: 'allow', segments: ['ls'] });
  assert.deepEqual(calls.map((call) => call.command), ['ls']);
});

test('automatic successful calls do not reset rejection counts', async () => {
  const chain = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 99, total: 3 }, ask: async () => true });
  chain.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'ls' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'ls' } });
  assert.deepEqual(chain.denials(), { consecutive: 2, total: 2 });
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  assert.deepEqual(chain.denials(), { consecutive: 3, total: 3 });
  assert.equal(chain.mode, 'ask');
});

test('an unknown mode or a threshold below one fails at once', () => {
  assert.throws(() => createDecisionChain({ mode: 'yolo' as unknown as PolicyMode }), (error) => hasCode(error, 'policy_mode_unknown'));
  assert.throws(
    () => createDecisionChain({ thresholds: { consecutive: 0, total: 5 } }),
    (error) => error instanceof KernelError && error.code === 'policy_thresholds_required',
  );
});

test('the kernel runs every call through the decision chain and reports the code', async () => {
  const seen: unknown[] = [];
  const kernel = createKernel({
    policy: createDecisionChain({
      rules: [
        { tool: 'exec', decision: 'deny', match: 'rm *' },
        { tool: 'exec', decision: 'allow', match: 'ls' },
      ],
    }),
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }),
    logger: { debug: () => {}, log: (message, fields) => seen.push(fields), error: () => {} },
  });
  kernel.register({
    name: 'exec',
    description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    access: 'exec',
    run: async () => 'ran',
  });
  await assert.rejects(
    () => kernel.call('exec', { command: 'rm -rf /tmp/x' }),
    (error) => hasCode(error, 'policy_denied'),
  );
  assert.deepEqual(seen[0], { tool: 'exec', code: 'policy_denied', reason: 'exec 被规则表拒绝' });
  assert.equal(await kernel.call('exec', { command: 'ls' }), 'ran');
});

// Host 选择命令语法后，策略按同一种语法解析并判定；不同后端可能对同一文本得出不同结论。
const POWERSHELL: ShellSelection = { kind: 'powershell', executable: 'pwsh.exe', prefix: ['-Command'], tail: '' };

test('the PowerShell backend judges only its own narrow subset', async () => {
  const { calls, ask } = asked(true, true);
  const chain = createDecisionChain({ mode: 'auto', ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'Get-ChildItem -Force' }, shell: POWERSHELL }), {
    decision: 'allow',
    segments: ['Get-ChildItem -Force'],
  });

  // 管道在 bash 那一档是可以逐段判的连接符，在 PowerShell 这一档不是：管道里过去的是对象，类型只有运行时知道。
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status | grep x' } }), {
    decision: 'allow',
    segments: ['git status', 'grep x'],
  });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'git status | grep x' }, shell: POWERSHELL })).decision, 'allow');
  assert.deepEqual(calls.map((call) => call.command), ['git status | grep x']);
  assert.match(calls[0].reason!, /powershell 的这一条命令没能完整读下来: |/);
  // 答复那一次要多看一眼的东西：答的是哪一种语法下的这条文本、跑起来会是哪一个可执行文件。
  assert.equal(calls[0].shell, 'powershell');
  assert.equal(calls[0].executable, 'pwsh.exe');

  // 两种命令后端都拒绝以脚本解释器开头的命令。
  assert.equal(
    (await chain.evaluate({ tool: 'exec', input: { command: 'python -c "print(1)"' }, shell: POWERSHELL })).decision,
    'allow',
  );
  assert.deepEqual(calls.map((call) => call.command), ['git status | grep x', 'python -c "print(1)"']);
});

// 验证审批档位来源和规则表可以分别完整替换。
test('the tier has two sources and the rule table can be replaced in place', async () => {
  const chain = createDecisionChain({ mode: 'ask', rules: [], ask: async () => true });
  assert.equal(chain.mode, 'ask');
  assert.equal(chain.modeSource, 'config');
  chain.setMode('auto');
  assert.equal(chain.mode, 'auto', '会话覆盖的那一份现在生效');
  assert.equal(chain.modeSource, 'session');
  chain.setConfiguredMode('ask');
  assert.equal(chain.mode, 'auto', '配置默认改了，会话自己覆盖过的那一份不动');
  assert.equal(chain.configuredMode(), 'ask');
  chain.resetMode();
  assert.equal(chain.mode, 'ask', '退回的就是配置那一份');
  assert.equal(chain.modeSource, 'config');
  assert.throws(() => chain.setMode('sometimes' as unknown as PolicyMode), (error) => hasCode(error, 'policy_mode_unknown'));
  chain.setRules([{ tool: 'exec', decision: 'deny', match: 'rm' }]);
  const denied = await chain.evaluate({ tool: 'exec', input: { command: 'rm something' } });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.via, 'rule', '新表里那一条现在就在判');
});

test('none allows ordinary in-bound tools without asking and still applies explicit deny rules', async () => {
  let asks = 0;
  const chain = createDecisionChain({
    mode: 'none',
    rules: [{ tool: 'delete', decision: 'deny', reason: 'keep this file' }],
    ask: async () => { asks += 1; return true; },
  });
  assert.deepEqual(await judged(chain, { tool: 'create', input: { path: 'app.js', content: 'demo' }, access: 'write' }), {
    decision: 'allow',
  });
  assert.deepEqual(await judged(chain, { tool: 'delete', input: { path: 'app.js' }, access: 'write' }), {
    decision: 'deny', code: 'policy_denied', reason: 'keep this file',
  });
  const hardDenied = await chain.evaluate({ tool: 'exec', input: { command: 'rm -rf /' } });
  assert.equal(hardDenied.code, 'policy_hard_denied');
  const privateTarget = await chain.evaluate({ tool: 'fetch', input: { url: 'http://10.0.0.2/' }, target: { class: 'private', addresses: ['10.0.0.2'] } as unknown as NetworkTarget });
  assert.equal(privateTarget.code, 'policy_manual_approval_disabled');
  assert.equal(asks, 0);
});

test('none does not turn operations that require a separate human boundary into ordinary calls', async () => {
  let asks = 0;
  const chain = createDecisionChain({ mode: 'none', ask: async () => { asks += 1; return true; } });
  const result = await chain.evaluate({
    tool: 'exec', input: { command: 'git status' }, requiresManualApproval: true,
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.code, 'policy_manual_approval_disabled');
  assert.equal(result.answer, 'unavailable');
  assert.equal(asks, 0);
});

test('none does not let forcedToAsk restore per-call prompts', async () => {
  let asks = 0;
  const chain = createDecisionChain({
    mode: 'none', thresholds: { consecutive: 1, total: 1 },
    ask: async () => { asks += 1; return true; },
  });
  const removeGuard = chain.guard(({ command }) => command === 'blocked' ? 'blocked by a guard' : undefined);
  await chain.evaluate({ tool: 'exec', input: { command: 'blocked' } });
  removeGuard();
  assert.equal(chain.snapshot().forcedToAsk, true);
  assert.equal((await chain.evaluate({ tool: 'read', input: { path: 'note.txt' } })).decision, 'allow');
  assert.equal(asks, 0);
});

test('legacy never keeps its existing refusal behavior for calls requiring approval', async () => {
  const chain = createDecisionChain({ mode: 'never', ask: async () => true });
  const result = await chain.evaluate({ tool: 'exec', input: { command: 'python -c "print(1)"' } });
  assert.equal(result.decision, 'deny');
  assert.equal(result.code, 'policy_denied');
  assert.equal(result.via, 'never');
});

test('a real human approval clears every denial counter and the forced mode', async () => {
  const chain = createDecisionChain({
    mode: 'ask', thresholds: { consecutive: 2, total: 5 },
    ask: async () => ({ decision: 'allow', source: 'human' }),
  });
  const removeGuard = chain.guard(() => 'denied by a test safety guard');
  await chain.evaluate({ tool: 'create', input: { path: 'first.txt' } });
  await chain.evaluate({ tool: 'create', input: { path: 'second.txt' } });
  assert.deepEqual(chain.denials(), { consecutive: 2, total: 2 });
  assert.equal(chain.snapshot().forcedToAsk, true);

  removeGuard();
  const allowed = await chain.evaluate({ tool: 'create', input: { path: 'app.js' } });
  assert.equal(allowed.decision, 'allow');
  assert.deepEqual(chain.denials(), { consecutive: 0, total: 0 });
  assert.equal(chain.snapshot().forcedToAsk, false);
});

test('an operator approval clears forced asking and restores the configured policy', async () => {
  const chain = createDecisionChain({
    mode: 'auto', thresholds: { consecutive: 2, total: 5 },
    ask: async () => ({ decision: 'allow', source: 'controller' }),
  });
  const removeGuard = chain.guard(() => 'denied by a test safety guard');
  await chain.evaluate({ tool: 'create', input: { path: 'first.txt' } });
  await chain.evaluate({ tool: 'create', input: { path: 'second.txt' } });
  assert.equal(chain.snapshot().forcedToAsk, true);
  removeGuard();
  const allowed = await chain.evaluate({ tool: 'create', input: { path: 'app.js' } });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.via, 'ask');
  assert.deepEqual(chain.denials(), { consecutive: 0, total: 0 });
  assert.equal(chain.snapshot().forcedToAsk, false);
  assert.equal(chain.mode, 'auto');
});

test('automatic and remembered allows do not reset denial history', async () => {
  const chain = createDecisionChain({
    mode: 'never', thresholds: { consecutive: 3, total: 5 },
    rules: [{ tool: 'read', decision: 'deny' }],
  });
  await chain.evaluate({ tool: 'read', input: { path: 'one.txt' } });
  await chain.evaluate({ tool: 'read', input: { path: 'two.txt' } });
  await chain.evaluate({ tool: 'read', input: { path: 'three.txt' } });
  assert.equal(chain.snapshot().forcedToAsk, true);
  chain.setRules([{ tool: 'read', decision: 'allow' }]);
  const allowed = await chain.evaluate({ tool: 'read', input: { path: 'four.txt' } });
  assert.equal(allowed.decision, 'allow');
  assert.deepEqual(chain.denials(), { consecutive: 3, total: 3 });
  assert.equal(chain.snapshot().forcedToAsk, true);
});

test('an unavailable approval channel is not reported or counted as a human denial', async () => {
  const chain = createDecisionChain({ mode: 'ask' });
  const result = await chain.evaluate({ tool: 'create', input: { path: 'app.js' } });
  assert.equal(result.decision, 'deny');
  assert.equal(result.code, 'ask_unavailable');
  assert.equal(result.answer, 'unavailable');
  assert.notEqual(result.reason, 'the user declined');
  assert.deepEqual(chain.denials(), { consecutive: 0, total: 0 });
});

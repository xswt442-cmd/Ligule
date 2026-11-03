import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../dist/index.js';
import { inspectCommand } from '../dist/capability/command.js';

test('a simple command is one segment and the safe operators split it into several', async () => {
  assert.deepEqual(await parseCommand('git status'), { kind: 'segments', segments: ['git status'] });
  assert.deepEqual(await parseCommand('git status | grep x'), { kind: 'segments', segments: ['git status', 'grep x'] });
  assert.deepEqual(await parseCommand('rm -rf /tmp/x && echo ok'), { kind: 'segments', segments: ['rm -rf /tmp/x', 'echo ok'] });
  assert.deepEqual(await parseCommand('ls; pwd'), { kind: 'segments', segments: ['ls', 'pwd'] });
});

test('an operator inside a quoted argument does not split the command', async () => {
  // 这一条是按语法解析而不是按字符切分才拿得到的：正则会在引号里那个竖线上切错。
  assert.deepEqual(await parseCommand('git commit -m "a | b"'), { kind: 'segments', segments: ['git commit -m "a | b"'] });
});

test('a construct outside the supported subset is reported by name', async () => {
  assert.deepEqual(await parseCommand('echo $(whoami)'), { kind: 'unsupported', construct: 'command_substitution' });
  assert.deepEqual(await parseCommand('cat < /etc/hosts'), { kind: 'unsupported', construct: 'redirected_statement' });
  assert.deepEqual(await parseCommand('echo $HOME'), { kind: 'unsupported', construct: 'simple_expansion' });
  assert.deepEqual(await parseCommand('for f in *; do echo "$f"; done'), { kind: 'unsupported', construct: 'for_statement' });
});

test('a command that does not parse, and one that is empty, are both reported', async () => {
  assert.deepEqual(await parseCommand('not bash at all (((('), { kind: 'unsupported', construct: 'a syntax error' });
  assert.deepEqual(await parseCommand('   '), { kind: 'unsupported', construct: 'no command' });
});

test('an interpreter wrapper stays one segment: the shell is not unwrapped', async () => {
  assert.deepEqual(await parseCommand('bash -lc "git status"'), { kind: 'segments', segments: ['bash -lc "git status"'] });
});

// PowerShell 只允许简单命令和 ASCII 字面参数，不允许管道。
test('the PowerShell subset takes a literal command with literal arguments', async () => {
  assert.deepEqual(await parseCommand('git status', 'powershell'), { kind: 'segments', segments: ['git status'] });
  assert.deepEqual(await parseCommand('Get-ChildItem -Recurse -Force', 'powershell'), {
    kind: 'segments',
    segments: ['Get-ChildItem -Recurse -Force'],
  });
  // `--flag=value` 是一个完整参数，等号不需要额外处理。
  assert.deepEqual(await parseCommand('npm install --name=git', 'powershell'), {
    kind: 'segments',
    segments: ['npm install --name=git'],
  });
  assert.deepEqual(await parseCommand('git commit -m "plain message"', 'powershell'), {
    kind: 'segments',
    segments: ['git commit -m "plain message"'],
  });
  assert.deepEqual(await parseCommand('mkdir a; cd a', 'powershell'), { kind: 'segments', segments: ['mkdir a', 'cd a'] });
});

test('PowerShell syntax that carries meaning beyond one literal command is reported by name', async () => {
  // 管道在这一档里不是一个可以逐段判的连接符：过去的是对象，类型只有运行时知道。
  assert.deepEqual(await parseCommand('Get-Process | Stop-Process', 'powershell'), { kind: 'unsupported', construct: '|' });
  assert.deepEqual(await parseCommand('$(whoami)', 'powershell'), { kind: 'unsupported', construct: 'sub_expression' });
  assert.deepEqual(await parseCommand('{ Get-Process }', 'powershell'), { kind: 'unsupported', construct: 'script_block_expression' });
  assert.deepEqual(await parseCommand('Get-ChildItem @params', 'powershell'), { kind: 'unsupported', construct: 'variable' });
  assert.deepEqual(await parseCommand('& notepad', 'powershell'), { kind: 'unsupported', construct: 'command_invocation_operator' });
  assert.deepEqual(await parseCommand('git add . > out.txt', 'powershell'), { kind: 'unsupported', construct: 'redirection' });
  assert.deepEqual(await parseCommand('npm run build 2>&1', 'powershell'), { kind: 'unsupported', construct: 'redirection' });
  // 声明与指令一类：树里各自有名字，认不出来就不猜。
  assert.deepEqual(await parseCommand('using module X', 'powershell'), { kind: 'unsupported', construct: 'using_directive_list' });
  assert.deepEqual(await parseCommand('class Foo { }', 'powershell'), { kind: 'unsupported', construct: 'class_statement' });
  assert.deepEqual(await parseCommand('function f { x }', 'powershell'), { kind: 'unsupported', construct: 'function_statement' });
  assert.deepEqual(await parseCommand('git status # drop', 'powershell'), { kind: 'unsupported', construct: 'comment' });
});

test('a PowerShell argument that is not a plain ASCII literal is reported instead of guessed', async () => {
  // 双引号在 PowerShell 里会展开：树把 `$(...)` 单列出来，但 `$x` 只是串里的文本，所以按内容而不是只按节点类型判。
  assert.deepEqual(await parseCommand('git commit -m "cost $(whoami)"', 'powershell'), {
    kind: 'unsupported',
    construct: 'an expandable string',
  });
  assert.deepEqual(await parseCommand('git commit -m $env:MSG', 'powershell'), { kind: 'unsupported', construct: 'variable' });
  // 这一批 Unicode 字符在 PowerShell 里是语法别名，落在字面量里也一样挡掉。
  assert.deepEqual(await parseCommand('Write-Host "a–b"', 'powershell'), { kind: 'unsupported', construct: 'a Unicode syntax alias' });
  // 解析报错与不认识的后缀运算都按无法完整处理对待，不降级成「按 bash 的直觉读一遍」。
  assert.deepEqual(await parseCommand('git log --author="Jane Doe"', 'powershell'), { kind: 'unsupported', construct: 'a syntax error' });
  assert.deepEqual(await parseCommand('git log -1', 'powershell'), { kind: 'unsupported', construct: 'expression_with_unary_operator' });
});

test('AST inspection preserves wrapper arguments and nested Bash commands', async () => {
  const wrapped = await inspectCommand('bash -c "rm -rf ~ | echo x"');
  assert.equal(wrapped.invocations[0].executable, 'bash');
  assert.deepEqual(wrapped.invocations[0].arguments.map((argument) => argument.value), ['-c', 'rm -rf ~ | echo x']);

  const escaped = await inspectCommand(String.raw`bash -c "rm -rf \"$HOME\"/*"`);
  assert.equal(escaped.invocations[0].arguments[1].value, 'rm -rf "$HOME"/*');

  const substitution = await inspectCommand('echo $(rm -rf ~)');
  assert.equal(substitution.parsed.kind, 'unsupported');
  assert.equal(substitution.invocations[0].executable, 'echo');
  assert.equal(substitution.invocations[0].arguments[0].nested[0].executable, 'rm');

  const backtick = await inspectCommand('echo `rm -rf ~`');
  assert.equal(backtick.invocations[0].arguments[0].nested[0].executable, 'rm');
});

test('Bash executable names are decoded from literals and mark dynamic names', async () => {
  for (const command of ["'rm' -rf /", '"rm" -rf /', 'r""m -rf /', 'b""ash -c echo']) {
    const inspection = await inspectCommand(command);
    assert.equal(inspection.invocations[0].executable, command.startsWith('b') ? 'bash' : 'rm', command);
    assert.equal(inspection.invocations[0].executableDynamic, false, command);
  }

  const escaped = await inspectCommand(String.raw`r\m -rf /`);
  assert.equal(escaped.invocations[0].executable, 'rm');
  assert.equal(escaped.invocations[0].executableDynamic, false);

  const ansiC = await inspectCommand(String.raw`$'r\x6d' -rf /`);
  assert.equal(ansiC.invocations[0].executable, 'rm');
  assert.equal(ansiC.invocations[0].executableDynamic, false);

  const escapedPath = await inspectCommand(String.raw`rm -rf /home\/alice`);
  assert.equal(escapedPath.invocations[0].arguments[1].value, '/home/alice');

  const ansiCPath = await inspectCommand(String.raw`rm -rf $'\x2f'`);
  assert.equal(ansiCPath.invocations[0].arguments[1].value, '/');

  const unknownAnsiEscape = await inspectCommand(String.raw`$'r\q' -rf /`);
  assert.equal(unknownAnsiEscape.invocations[0].executableDynamic, true);

  const dynamic = await inspectCommand(`${String.fromCharCode(36)}command -rf /`);
  assert.equal(dynamic.parsed.kind, 'unsupported');
  assert.equal(dynamic.invocations[0].executableDynamic, true);

  const substitution = await inspectCommand(`${String.fromCharCode(36)}(rm -rf ~)`);
  assert.equal(substitution.invocations[0].executableNested?.[0]?.executable, 'rm');
});

test('AST inspection preserves PowerShell variables, aliases, and subexpressions', async () => {
  const removal = await inspectCommand('Remove-Item -Path "$env:USERPROFILE\\*" -Recurse -Force', 'powershell');
  assert.equal(removal.parsed.kind, 'unsupported');
  assert.equal(removal.invocations[0].executable, 'Remove-Item');
  assert.equal(removal.invocations[0].arguments[1].value, '$env:USERPROFILE\\*');

  const quotedRoot = await inspectCommand("Remove-Item -Path 'C:\\*' -Recurse -Force", 'powershell');
  assert.equal(quotedRoot.invocations[0].arguments[1].value, 'C:\\*');

  const wrapper = await inspectCommand('pwsh -enc SGVsbG8=');
  assert.equal(wrapper.invocations[0].executable, 'pwsh');
  assert.deepEqual(wrapper.invocations[0].arguments.map((argument) => argument.value), ['-enc', 'SGVsbG8=']);

  const substitution = await inspectCommand('Write-Output $(Remove-Item -Path C:\\* -Recurse -Force)', 'powershell');
  assert.equal(substitution.invocations[0].executable, 'Write-Output');
  assert.equal(substitution.invocations[0].arguments[0].nested[0].executable, 'Remove-Item');
});

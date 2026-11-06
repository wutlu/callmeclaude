import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnly, isReadOnlyCommand } from '../src/readOnly.ts';

test('looking around is read-only', () => {
  for (const c of [
    'git status --short',
    'git -C apps/desktop log --oneline -5',
    'gh run list --workflow desktop-release.yml -L 3',
    'gh run view 42245458511 --log-failed | tail -n 80',
    'gh release view desktop-v0.1.0 --json assets -q ".assets[].name"',
    'cd apps/desktop && cat package.json | jq .build',
    'ls -la release 2>/dev/null',
    "grep -rn 'executableName' src | head",
    'find . -name "*.ts" -not -path "*/node_modules/*"',
    'sed -n 1,40p src/main.ts',
    'gh api repos/wutlu/callmeclaude/actions/runs',
  ])
    assert.ok(isReadOnlyCommand(c), c);
});

test('anything that changes, runs or sends something still asks', () => {
  for (const c of [
    'git push origin main',
    'git tag desktop-v0.1.1',
    'git branch -D old',
    'git commit -m x',
    'git -c core.pager=evil log',
    'gh release upload desktop-v0.1.0 a.AppImage',
    'gh workflow run desktop-release.yml',
    'gh api -X DELETE repos/a/b',
    'gh api repos/a/b -f name=x',
    'cat a > b',
    'ls; rm -rf /',
    'ls && npm publish',
    'echo $(rm x)',
    'echo `rm x`',
    'sed -i s/a/b/ f',
    'find . -delete',
    'find . -exec rm {} ;',
    'FOO=1 ls',
    'npm test',
    'cat ~/.ssh/id_ed25519',
    'cat .env',
    'cat ~/.callmeclaude/config.json',
    'printenv',
    'sleep 5 &',
    'echo "unbalanced',
  ])
    assert.equal(isReadOnlyCommand(c), false, c);
});

test('read tools are read-only except on secret files; edits never are', () => {
  assert.ok(isReadOnly('Read', { file_path: '/Users/a/proj/package.json' }));
  assert.ok(isReadOnly('Grep', { pattern: 'executableName', path: 'src' }));
  assert.equal(isReadOnly('Read', { file_path: '/Users/a/.aws/credentials' }), false);
  assert.equal(isReadOnly('Read', { file_path: '/Users/a/proj/.env.local' }), false);
  assert.equal(isReadOnly('Edit', { file_path: 'a.ts' }), false);
  assert.equal(isReadOnly('WebFetch', { url: 'https://x' }), false);
  assert.equal(isReadOnly('mcp__x__delete', {}), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../src/util.ts';

test('plainText strips markdown from summaries', () => {
  assert.equal(plainText('Bu sefer **`OPENAI_API_KEY`:** güncellendi'), 'Bu sefer OPENAI_API_KEY: güncellendi');
  assert.equal(plainText('It printed: ``` Hello, World! ``` done'), 'It printed: Hello, World! done');
  assert.equal(plainText('## Result\n- one\n- two'), 'Result one two');
  assert.equal(plainText('Done: - **a** fixed - b added'), 'Done: a fixed - b added');
  assert.equal(plainText('See [the docs](https://x.y) and _this_ file_name.ts'), 'See the docs and this file_name.ts');
  assert.equal(plainText('3 * 4 - 2 = 10'), '3 * 4 - 2 = 10');
  assert.equal(plainText(undefined), '');
});

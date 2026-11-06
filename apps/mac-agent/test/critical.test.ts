import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticalReason } from '../src/critical.ts';

test('everyday development is never critical', () => {
  const ok: Array<[string, any]> = [
    ['Edit', { file_path: 'src/checkout/payment.ts' }],
    ['Write', { file_path: 'signup.tsx', content: 'password field, credit card form' }],
    ['Bash', { command: 'npm install stripe && npm test' }],
    ['Bash', { command: 'git push origin main' }],
    ['Bash', { command: 'vercel deploy --prod' }],
    ['Bash', { command: 'rm -rf node_modules dist .next' }],
    ['Bash', { command: 'gh run view 42245458511 --log-failed' }],
    ['Bash', { command: 'echo 1793983163257' }],
    ['Bash', { command: 'docker compose down && docker compose up -d' }],
    ['WebFetch', { url: 'https://docs.stripe.com/payments' }],
    ['mcp__claude-in-chrome__navigate', { url: 'https://localhost:3000/dashboard' }],
    ['mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 20] }],
    ['mcp__figma__get_screenshot', { nodeId: '1:2' }],
    ['mcp__claude-in-chrome__find', { query: 'Sign up button' }],
    ['mcp__claude-in-chrome__get_page_text', {}],
    ['mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }],
  ];
  for (const [t, i] of ok) assert.equal(criticalReason(t, i), undefined, `${t} ${JSON.stringify(i)}`);
});

test('money, accounts, credentials, messages to people and wiping data are critical', () => {
  const bad: Array<[string, any]> = [
    ['mcp__claude-in-chrome__form_input', { ref: 'cc', value: '4242 4242 4242 4242' }],
    ['mcp__claude-in-chrome__computer', { action: 'left_click', text: 'Place order' }],
    ['mcp__claude-in-chrome__form_input', { ref: 'pw', value: 'x', label: 'Password' }],
    ['mcp__peekaboo__type', { text: 'Siparişi tamamla' }],
    ['mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' }],
    ['mcp__claude_ai_Slack__post_message', { text: 'hi' }],
    ['mcp__claude_ai_Google_Drive__trash_file', { id: 'x' }],
    ['Bash', { command: 'rm -rf ~/' }],
    ['Bash', { command: 'cd /tmp && rm -rf /' }],
    ['Bash', { command: 'git push --force origin main' }],
    ['Bash', { command: 'git reset --hard HEAD~3' }],
    ['Bash', { command: 'psql -c "DROP DATABASE prod"' }],
    ['Bash', { command: 'curl -X POST https://api.stripe.com/v1/charges -d amount=100' }],
    ['Bash', { command: 'curl -d "{}" https://hooks.slack.com/services/T/B/X' }],
    ['Bash', { command: 'gh repo delete wutlu/x --yes' }],
  ];
  for (const [t, i] of bad) assert.ok(criticalReason(t, i), `${t} ${JSON.stringify(i)}`);
});

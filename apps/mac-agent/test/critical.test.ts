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

// Shapes that made the hub ask a developer for nothing on a real machine: a mail folder, a mail.ts file, a mail(...) helper in
// test code, a grep pattern that lists "mail", a messaging or payment host inside grep / sed / git, a UUID read as a
// card number, a question to the developer that mentions a login.
test('mail as a path, a file name or a word is not sending a message', () => {
  const ok = [
    'cat src/mail/send.ts',
    'ls packages/mail && cat mail.ts',
    'pnpm --filter ./packages/mail test',
    'grep -rn "mail" src/',
    'grep -E "(mail|chat|sms)" src/channels.ts',
    'git diff --stat HEAD~1 | grep -v "\\(mail\\|chat\\)/"',
    'wc -l src/{mail,chat}.ts',
    'cd src && head -5 mail.ts',
    'sed -n 1,40p src/mail/mail.service.ts',
    "cat > t.js <<'EOF'\nconst mail = (n) => `${n}@example.com`;\nsend({ to: mail('a') });\nif (!mail) { throw new Error('no mail') }\nEOF",
    'node -e "require(\'./dist/mail\').render()"',
    'docker logs mail | tail',
    'git log --oneline -- src/mail',
    'vim src/mail/index.ts',
  ];
  for (const command of ok) assert.equal(criticalReason('Bash', { command }), undefined, command);
});

test('mail, mailx, mutt and sendmail run as a command still ask', () => {
  const bad = [
    'mail -s "Release notes" team@example.com < notes.txt',
    'echo hi | mail -s test boss@example.com',
    'cat msg.eml | /usr/sbin/sendmail -t',
    'sendmail someone@example.com < body.txt',
    'cd /tmp && mailx -s report a@b.c < r.txt',
    'mutt -s "Invoice" client@example.com -a invoice.pdf < body',
    'sudo -u postfix sendmail -t < m',
    'env LANG=C mail -s hi a@b.c < x',
    'FROM=me@x.y mail -s hi a@b.c < x',
    'npm test; mail -s done me@example.com < log',
    'make build || mail -s failed me@example.com < log',
    'echo "$(mail -s hi a@b.c < x)"',
    'bash -c "mail -s hi a@b.c < x"',
    "ssh prod 'mail -s hi a@b.c < x'",
    'ls *.eml | xargs -I{} sendmail -t < {}',
    'if true; then mail -s hi a@b.c < x; fi',
    'timeout 10 sendmail -t < m',
  ];
  for (const command of bad) assert.equal(criticalReason('Bash', { command }), 'sends a message to other people', command);
});

test('a payment or messaging host is critical only when a request goes to it', () => {
  const ok = [
    'grep -rn "api.resend.com" src/',
    'rg "api\\.stripe\\.com|hooks\\.slack\\.com" packages',
    'cat src/mail/resend.ts | grep api.resend.com/emails',
    "sed -i 's#api.sendgrid.com#api.resend.com#' src/mail/provider.ts",
    'git log -S "api.postmarkapp.com" --oneline',
    'git grep -n api.twilio.com',
    'pnpm vitest run test/stripe.test.ts -t "api.stripe.com/v1/charges"',
    'code src/billing/paddle.com.ts',
    'echo https://api.telegram.org/bot >> docs/hosts.txt',
    'grep -rn "fetch(\'https://api.resend.com" src/',
  ];
  for (const command of ok) assert.equal(criticalReason('Bash', { command }), undefined, command);

  const send = [
    'curl -X POST https://api.resend.com/emails -H "Authorization: Bearer $K" -d @mail.json',
    'curl -d "{}" https://hooks.slack.com/services/T/B/X',
    'wget --post-data "a=b" https://api.mailgun.net/v3/x/messages',
    'http POST https://api.postmarkapp.com/email To=a@b.c',
    'URL=https://api.resend.com/emails; curl -X POST "$URL" -d @m.json',
    'node -e "fetch(\'https://api.resend.com/emails\', { method: \'POST\' })"',
    "python3 -c \"import requests; requests.post('https://api.twilio.com/2010-04-01/Accounts/x/Messages.json')\"",
    'sudo curl https://discord.com/api/webhooks/1/x -d content=hi',
    'node scripts/notify.mjs https://hooks.slack.com/services/T/B/X',
    './bin/send-sms --endpoint https://api.twilio.com/2010-04-01',
  ];
  for (const command of send) assert.equal(criticalReason('Bash', { command }), 'sends a message to other people', command);

  const pay = [
    'curl -X POST https://api.stripe.com/v1/charges -d amount=100',
    'curl https://api-m.paypal.com/v2/checkout/orders -d @order.json',
    'stripe charges create --amount 100',
  ];
  for (const command of pay) assert.equal(criticalReason('Bash', { command }), 'moves money', command);
});

test('UUIDs are not card numbers, real card numbers still are', () => {
  assert.equal(criticalReason('Bash', { command: 'claude --resume 11111111-2222-3333-4444-555555555555 -p hi' }), undefined);
  assert.equal(criticalReason('Bash', { command: 'echo 99999999-2222-3333-4444-555555555555' }), undefined);
  assert.equal(criticalReason('Bash', { command: 'echo 4242 4242 4242 4242' }), 'contains a card number');
  assert.equal(criticalReason('Bash', { command: 'echo 4242424242424242' }), 'contains a card number');
  assert.equal(criticalReason('mcp__claude-in-chrome__form_input', { ref: 'x', value: '4242-4242-4242-4242' }), 'enters a card number');
});

test('a question to the developer is never critical, the same words in a browser still are', () => {
  const q = { questions: [{ question: 'Log in with the test user (password in .env) and pick "Logged in".', header: 'Login', options: [{ label: 'Logged in' }] }] };
  assert.equal(criticalReason('AskUserQuestion', q), undefined);
  assert.ok(criticalReason('mcp__claude-in-chrome__form_input', { ref: 'pw', value: 'x', label: 'Password' }));
  assert.ok(criticalReason('SomeUnknownTool', { text: 'enter your password' }));
});

test('wiping and history rules are unchanged', () => {
  const bad = [
    'psql -c "DROP DATABASE IF EXISTS app_test;"',
    'git push --force-with-lease origin feat',
    'git push origin +main',
    'git clean -fd',
    'rm -rf ../',
    'aws s3 rm s3://bucket --recursive',
  ];
  for (const command of bad) assert.ok(criticalReason('Bash', { command }), command);
});

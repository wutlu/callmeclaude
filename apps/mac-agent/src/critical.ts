// "Only ask me for critical things": every permission request is approved by the hub unless the action
// spends money, creates an account or signs in, hands over credentials, sends something to other people,
// or destroys data that can't be brought back. Editing code ABOUT payments is not paying, so file tools
// are never critical; only actions that reach the outside world (or wipe data) are checked.

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'TodoWrite', 'BashOutput', 'KillShell', 'ToolSearch', 'WebSearch', 'WebFetch', 'Task', 'Agent', 'Skill']);

/** Words that mean money moves, an account is made, or someone logs in: checked in what a browser/app tool types, fills or opens. */
const MONEY_OR_ACCOUNT =
  /\b(checkout|check out|pay now|payment|purchase|buy now|place (the |your )?order|complete (the )?order|subscribe|upgrade plan|add to cart|billing|credit card|card number|cvv|cvc|iban|swift|wire transfer|bank transfer|sign ?up|register|create (an |your )?account|join now|log ?in|sign ?in|password|passcode|one-time code|2fa|verification code)\b|ödeme|öde\b|satın al|sipariş ver|siparişi tamamla|abone ol|üye ol|kayıt ol|hesap oluştur|giriş yap|şifre|kart numarası/i;

/** A card number: 13-19 digits (optionally grouped) that pass the Luhn check, so ids and timestamps don't count. */
function hasCard(text: string): boolean {
  for (const m of text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** App tools (MCP) whose name says they send, publish, delete, buy or create an account. */
const ACTION_NAME =
  /(^|_)(send|reply|forward|post|publish|share|invite|delete|trash|remove|purchase|order|pay|checkout|transfer|signup|sign_up|register|create_account|respond_to_event|create_event|update_event)(_|$)/i;

/** Browser / computer-control tools that only look (no click, no typing). */
const LOOKS_ONLY = /^(find|read_page|get_page_text|read_console_messages|read_network_requests|tabs_context(_mcp)?|see|list|image|screenshot|list_connected_browsers|shortcuts_list)$/i;

/** Browser / computer-control tools: these click and type on real sites and apps. */
const DRIVES_UI = /claude-in-chrome|peekaboo|computer|browser|playwright|puppeteer/i;

const PAY_HOSTS = /api\.stripe\.com|api(-m)?\.paypal\.com|api\.iyzipay\.com|paddle\.com|lemonsqueezy\.com|api\.braintreegateway\.com|checkout\./i;
const SEND_HOSTS = /hooks\.slack\.com|slack\.com\/api\/chat\.|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.resend\.com|api\.postmarkapp\.com|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot/i;

/** Why this action needs the developer, or undefined if the hub can approve it. */
export function criticalReason(tool: string, input: any): string | undefined {
  if (FILE_TOOLS.has(tool)) return;
  if (tool === 'Bash') return bashReason(String(input?.command ?? ''));
  const text = JSON.stringify(input ?? {});
  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').slice(2).join('__');
    if (ACTION_NAME.test(name)) return 'sends, publishes, deletes or buys something in another app';
    if (DRIVES_UI.test(tool) && !LOOKS_ONLY.test(name)) {
      if (hasCard(text)) return 'enters a card number';
      if (MONEY_OR_ACCOUNT.test(text)) return 'payment, sign-up or login on a website or app';
    }
    return;
  }
  // Unknown tool: only stop it when it plainly talks about money or accounts.
  if (hasCard(text) || MONEY_OR_ACCOUNT.test(text)) return 'payment, sign-up or login';
}

function bashReason(cmd: string): string | undefined {
  const c = cmd.replace(/\s+/g, ' ');
  // Data that can't be brought back.
  if (wipesBroadly(c)) return 'deletes a whole folder outside the project';
  if (/\bgit push\b[^|;&]*\s(-f|--force|--force-with-lease|--mirror|--delete)\b|\bgit push\b[^|;&]*\s\+\S/i.test(c)) return 'overwrites or deletes history on the server';
  if (/\bgit (reset --hard|clean -[a-z]*f[a-z]*d|clean -[a-z]*d[a-z]*f)\b/i.test(c)) return 'throws away uncommitted work';
  if (/\b(drop (database|schema|table)|truncate table|dropdb)\b|\bmkfs\b|\bdd [^|;&]*\bof=\/dev\//i.test(c)) return 'wipes a database or a disk';
  if (/\b(gh repo delete|gh release delete|vercel (rm|remove)|heroku apps:destroy|aws s3 (rb|rm [^|;&]*--recursive)|gcloud [^|;&]* delete|firebase [^|;&]*delete|supabase [^|;&]*delete)\b/i.test(c)) return 'deletes a project or its data in the cloud';
  // Money.
  if (/\bstripe (charges|payment_intents|subscriptions|refunds|transfers|payouts|invoices) (create|pay|confirm|update)\b/i.test(c) || PAY_HOSTS.test(c)) return 'moves money';
  // Messages to other people.
  if (/\b(sendmail|mailx?|mutt|osascript [^|;&]*(Mail|Messages|WhatsApp)[^|;&]*send)\b/i.test(c) || SEND_HOSTS.test(c)) return 'sends a message to other people';
  // Accounts and credentials typed on the command line.
  if (/\b(signup|sign-up|register|create-account)\b/i.test(c) && /\b(curl|http|wget|gh api)\b/.test(c)) return 'creates an account';
  if (hasCard(c)) return 'contains a card number';
}

/** rm -r aimed at the root, the home folder, a parent folder or everything. */
function wipesBroadly(c: string): boolean {
  for (const seg of c.split(/&&|\|\||[;|]/)) {
    const w = seg.trim().split(' ');
    const at = w.findIndex((x) => x === 'rm');
    if (at < 0) continue;
    const args = w.slice(at + 1);
    if (!args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')) continue;
    if (args.some((a) => /^["']?(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$HOME\/\*|\.\.(\/.*)?|\*|\.\/\*)["']?$/.test(a))) return true;
  }
  return false;
}

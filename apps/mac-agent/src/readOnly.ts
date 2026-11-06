// Permission requests that only look at things (read a file, list files, check git or CI status) are
// approved without calling the developer. Anything that could change, run or send something still asks.
// Conservative by design: when in doubt the answer is "not read-only".

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'BashOutput', 'ToolSearch', 'WebSearch']);

/** Paths whose contents are secrets: never read them without asking, even read-only. */
const SECRET = /(^|[\s/'"=~])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.config\/gh|\.callmeclaude|keychains?|\.env\b|\.env\.|id_rsa|id_ed25519|credentials|secrets?\b|\.pem\b|\.p12\b|\.p8\b|\.key\b|token)/i;

const PLAIN = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'rg', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df',
  'date', 'tree', 'sort', 'uniq', 'cut', 'tr', 'jq', 'basename', 'dirname', 'realpath', 'diff', 'cd', 'true', 'sleep', 'column',
  'nl', 'cmp', 'md5', 'shasum', 'sha256sum', 'whoami', 'uname', 'ps', 'uptime',
]);

const GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog', 'ls-remote', 'cat-file', 'grep', 'whatchanged']);

const GH: Record<string, Set<string>> = {
  run: new Set(['list', 'view', 'watch']),
  pr: new Set(['list', 'view', 'status', 'checks', 'diff']),
  release: new Set(['list', 'view']),
  issue: new Set(['list', 'view', 'status']),
  repo: new Set(['view']),
  workflow: new Set(['list', 'view']),
  cache: new Set(['list']),
};

export function isReadOnly(tool: string, input: any): boolean {
  if (READ_TOOLS.has(tool)) {
    const target = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '') + ' ' + String(input?.pattern ?? '');
    return !SECRET.test(target);
  }
  if (tool !== 'Bash') return false;
  return isReadOnlyCommand(String(input?.command ?? ''));
}

export function isReadOnlyCommand(cmd: string): boolean {
  if (!cmd.trim() || SECRET.test(cmd)) return false;
  // Harmless stderr redirections; any other redirection, substitution or multi-line script is not read-only.
  const c = cmd.replace(/\s\d?>\s*\/dev\/null/g, ' ').replace(/\s2>&1/g, ' ');
  if (/[`\n<>]|\$\(|\$\{|&\s*$|(^|[^&])&([^&]|$)/.test(c)) return false;
  const parts = splitCommand(c);
  return !!parts && parts.length > 0 && parts.every(segmentReadOnly);
}

/** Split on && || ; | outside quotes; undefined if quotes are unbalanced. */
function splitCommand(c: string): string[][] | undefined {
  const out: string[][] = [];
  let words: string[] = [];
  let w = '';
  let has = false;
  let q: string | undefined;
  const push = () => {
    if (has) words.push(w);
    w = '';
    has = false;
  };
  const end = () => {
    push();
    out.push(words);
    words = [];
  };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) {
      if (ch === q) q = undefined;
      else w += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (ch === '\\') {
      w += c[++i] ?? '';
      has = true;
    } else if (/\s/.test(ch)) push();
    else if (ch === ';' || ch === '|' || (ch === '&' && c[i + 1] === '&')) {
      if ((ch === '|' || ch === '&') && c[i + 1] === ch) i++;
      end();
    } else {
      w += ch;
      has = true;
    }
  }
  if (q) return;
  end();
  return out.filter((s) => s.length);
}

function segmentReadOnly(words: string[]): boolean {
  const [cmd, ...args] = words;
  if (!cmd || /=/.test(cmd)) return false; // VAR=x cmd: could change how cmd behaves
  if (PLAIN.has(cmd)) return true;
  if (cmd === 'sed') return !args.some((a) => /^(-i|--in-place)/.test(a) || /(^|;)\s*[ew]\b|\/[ew]\s*$/.test(a));
  if (cmd === 'find') return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a));
  if (cmd === 'git') {
    let i = 0;
    while (args[i] === '-C' || args[i] === '--no-pager') i += args[i] === '--no-pager' ? 1 : 2;
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (GIT.has(sub)) return !rest.some((a) => /^--(output|ext-diff)/.test(a));
    if (sub === 'branch') return rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--show-current|--merged|--no-merged)$/.test(a));
    if (sub === 'tag') return rest.length === 0 || rest.every((a) => /^(-l|--list|-n\d*|--contains|--points-at|--sort=.*)$/.test(a));
    if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v');
    if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
    if (sub === 'config') return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l';
    return false;
  }
  if (cmd === 'gh') {
    const [group, sub] = args;
    if (GH[group]?.has(sub)) return !args.includes('--web');
    if (group === 'api') return !args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a));
    return false;
  }
  return false;
}

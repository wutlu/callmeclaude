import { execFileSync } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { platform } from './platform/index.ts';
import { execFileP } from './util.ts';

export async function tailscaleInfo(): Promise<{ ip?: string; dns?: string }> {
  for (const bin of platform.tailscaleBins) {
    try {
      const { stdout } = await execFileP(bin, ['status', '--json'], { timeout: 4000 });
      const j = JSON.parse(stdout);
      return { ip: j.Self?.TailscaleIPs?.find((x: string) => x.includes('.')), dns: String(j.Self?.DNSName ?? '').replace(/\.$/, '') || undefined };
    } catch {}
  }
  return {};
}

/**
 * IPv4 addresses on the local network. Link-local 169.254.x (USB / Thunderbolt bridges, no DHCP) is
 * never reachable from the phone, and 100.x is Tailscale's (listed separately). `isLan` drops whole
 * interfaces per OS: VPN tunnels on macOS; Tailscale and container / VM bridges on Linux.
 */
export function lanIps(ifaces = networkInterfaces(), isLan = platform.isLanInterface) {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? [])
      if (a.family === 'IPv4' && !a.internal && isLan(name) && !a.address.startsWith('100.') && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

/** The Bonjour (mDNS) name, e.g. "mutlu-MacBook-Pro.local": follows the computer to any Wi-Fi without re-pairing. */
export function mdnsName(): string | undefined {
  try {
    const n =
      platform.id === 'darwin'
        ? execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
        : hostname().split('.')[0];
    return /^[A-Za-z0-9-]+$/.test(n) ? `${n}.local` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every address the phone may reach the hub on, best first: Tailscale IP (works on cellular, no DNS),
 * Tailscale name, the current LAN IPs, then the Bonjour name (still right after the computer changes network).
 */
export function hubUrls(port: number, ts: { ip?: string; dns?: string }, lan: string[], mdns?: string): string[] {
  const hosts = [ts.ip, ts.dns, ...lan, mdns].filter((h): h is string => !!h);
  return [...new Set(hosts)].map((h) => `ws://${h}:${port}`);
}

export async function currentHubUrls(port: number) {
  return hubUrls(port, await tailscaleInfo(), lanIps(), mdnsName());
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubUrls, lanIps } from '../src/addresses.ts';

const nic = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as any;

test('LAN addresses skip link-local, Tailscale, loopback and VPN tunnels', () => {
  const ifaces = { lo0: [nic('127.0.0.1', true)], en0: [nic('192.168.8.114')], en12: [nic('169.254.108.66')], utun6: [nic('100.85.107.0')], en5: [nic('100.64.1.2')] };
  assert.deepEqual(lanIps(ifaces, (n) => !n.startsWith('utun')), ['192.168.8.114']);
});

test('hub URLs: Tailscale first, then LAN, then the Bonjour name; no duplicates', () => {
  assert.deepEqual(hubUrls(47801, { ip: '100.85.107.0', dns: 'mac.tail.ts.net' }, ['192.168.8.114'], 'mac.local'), [
    'ws://100.85.107.0:47801',
    'ws://mac.tail.ts.net:47801',
    'ws://192.168.8.114:47801',
    'ws://mac.local:47801',
  ]);
  assert.deepEqual(hubUrls(1, {}, ['10.0.0.2', '10.0.0.2'], undefined), ['ws://10.0.0.2:1']);
});

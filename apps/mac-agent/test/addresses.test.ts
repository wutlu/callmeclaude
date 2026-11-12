import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubUrls, lanIps } from '../src/addresses.ts';
import { linuxLanInterface } from '../src/platform/linux.ts';

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

test('Linux LAN addresses leave out container and VM bridges but keep VPNs the phone may share', () => {
  const ifaces = {
    lo: [nic('127.0.0.1', true)],
    wlan0: [nic('192.168.1.20')],
    enp3s0: [nic('10.0.0.5')],
    br0: [nic('192.168.2.7')],
    docker0: [nic('172.17.0.1')],
    'br-3f2a9c1d7e44': [nic('172.18.0.1')],
    veth12ab34: [nic('172.17.0.9')],
    virbr0: [nic('192.168.122.1')],
    podman0: [nic('10.88.0.1')],
    lxdbr0: [nic('10.10.10.1')],
    cni0: [nic('10.42.0.1')],
    vboxnet0: [nic('192.168.56.1')],
    tailscale0: [nic('100.85.1.2')],
    wg0: [nic('10.8.0.2')],
    ztabcdef12: [nic('10.147.17.3')],
    tun0: [nic('10.9.0.6')],
  };
  assert.deepEqual(lanIps(ifaces, linuxLanInterface), ['192.168.1.20', '10.0.0.5', '192.168.2.7', '10.8.0.2', '10.147.17.3', '10.9.0.6']);
});

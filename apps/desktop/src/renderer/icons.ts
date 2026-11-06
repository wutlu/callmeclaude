// Tray icons, drawn once at startup: a phone handset in the state's color.
import type { TrayTone } from '../shared.ts';

// Material Icons "call" glyph (Apache License 2.0, Google), 24×24 viewBox.
const HANDSET =
  'M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z';

const COLORS: Record<TrayTone, string> = {
  offline: '#8E8E93',
  idle: '#D97857', // Claude orange
  attention: '#FF9F0A',
  paused: '#FF453A',
  call: '#34C759',
};

function draw(px: number, color: string, alpha: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  g.globalAlpha = alpha;
  g.scale(px / 24, px / 24);
  g.fillStyle = color;
  g.fill(new Path2D(HANDSET));
  return c.toDataURL('image/png');
}

/**
 * Every tone at 1× and 2×. On macOS idle/offline are black template images (they follow the menu bar's
 * light/dark look); the other tones, and every tone elsewhere, are a colored handset (green = a call).
 */
export function trayIcons(platform: string) {
  const px = platform === 'darwin' ? 18 : platform === 'win32' ? 16 : 22;
  return (Object.keys(COLORS) as TrayTone[]).map((tone) => {
    const template = platform === 'darwin' && (tone === 'idle' || tone === 'offline');
    const color = template ? '#000000' : COLORS[tone];
    const alpha = tone === 'offline' ? 0.45 : 1;
    return { tone, template, x1: draw(px, color, alpha), x2: draw(px * 2, color, alpha) };
  });
}

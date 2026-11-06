// Bundles main, preload and the panel with esbuild; the packaged app has no node_modules.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: 'warning', target: 'es2023', legalComments: 'none' };
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src/main.ts')], outfile: join(out, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: [join(root, 'src/preload.ts')], outfile: join(out, 'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: [join(root, 'src/renderer/app.ts')], outfile: join(out, 'renderer/app.js'), platform: 'browser', format: 'iife' }),
]);
for (const f of ['index.html', 'style.css']) copyFileSync(join(root, 'src/renderer', f), join(out, 'renderer', f));
copyFileSync(join(root, 'build/icon.png'), join(out, 'icon.png'));
console.log('built', out);

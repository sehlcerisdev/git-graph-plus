import * as esbuild from 'esbuild';
import { copyFileSync } from 'fs';

const isWatch = process.argv.includes('--watch');
const isServer = process.argv.includes('--server');

if (isServer) {
  // Standalone web-server bundle. `vscode` is marked external for safety even
  // though the server never imports it; chokidar/ws/dotenv are bundled.
  await esbuild.build({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    outfile: 'dist/server.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    target: 'node18',
  });
  // Ship the standalone HTML next to the bundle so the runtime can serve it.
  copyFileSync('src/server/index.html', 'dist/server-index.html');
  console.log('Built dist/server.js');
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    target: 'node18',
  });

  if (isWatch) {
    console.log('Watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    ctx.dispose();
  }
}

import esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2020', platform: 'browser', outfile: 'main.js',
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
  await mkdir('dist/jev-classifier', { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    await copyFile(file, `dist/jev-classifier/${file}`);
  }
}

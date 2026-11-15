import path from 'node:path';
import { build } from 'esbuild';

await build({
  entryPoints: [path.join(import.meta.dirname, 'runtime.ts')],
  outfile: path.join(import.meta.dirname, 'runtime.min.js'),
  bundle: true, minify: true, format: 'iife', globalName: 'Studio',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@/lib/utils': path.join(import.meta.dirname, 'utils.ts') },
  legalComments: 'inline',
});

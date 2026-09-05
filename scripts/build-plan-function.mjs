import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = ['@supabase/supabase-js', '@vercel/blob', 'pdf-lib', 'bullmq'];
const imports = Object.fromEntries(packages.map(name => [name, `npm:${name}@${lock.packages[`node_modules/${name}`].version}`]));
await build({ entryPoints: ['supabase/functions/roughbid-plans/entry.ts'], outfile: 'supabase/functions/roughbid-plans/index.ts', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: [...packages, 'node:*'] });
await writeFile('supabase/functions/roughbid-plans/deno.json', JSON.stringify({ imports }, null, 2) + '\n');
console.log('Built Supabase plan function from shared backend sources.');

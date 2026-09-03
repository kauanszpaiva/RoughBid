import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await cp(new URL('../apps/web/index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));
await cp(new URL('../apps/web/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));

// Builds the RoughBid product app (apps/web/app) into dist/app/, alongside
// the static landing page copied above. See apps/web/app/vite.config.ts.
execFileSync(
  fileURLToPath(new URL('../node_modules/.bin/vite', import.meta.url)),
  ['build', '--config', fileURLToPath(new URL('../apps/web/app/vite.config.ts', import.meta.url))],
  { stdio: 'inherit' },
);

const serverOnlyKeys = ['SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY'];
async function assertNoServerSecrets(directory) {
  for (const name of await readdir(directory)) {
    const file = new URL(name, directory);
    if ((await stat(file)).isDirectory()) await assertNoServerSecrets(new URL(`${name}/`, directory));
    else {
      const contents = await readFile(file, 'utf8');
      for (const key of serverOnlyKeys) {
        const value = process.env[key];
        if (contents.includes(key) || (value && contents.includes(value))) {
          throw new Error(`Server-only secret leaked into browser output: ${key}`);
        }
      }
    }
  }
}

await assertNoServerSecrets(new URL('../dist/', import.meta.url));
console.log('Built static landing to dist/');

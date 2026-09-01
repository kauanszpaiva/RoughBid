import { cp, mkdir, rm } from 'node:fs/promises';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await cp(new URL('../apps/web/index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));
await cp(new URL('../apps/web/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));
console.log('Built static landing to dist/');

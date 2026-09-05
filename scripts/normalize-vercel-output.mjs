import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../.vercel/output/config.json', import.meta.url);
const config = JSON.parse(await readFile(file, 'utf8'));
config.overrides = Object.fromEntries(Object.entries(config.overrides ?? {}).map(([key, value]) => [key.replaceAll('\\','/'), { ...value, ...(value.path ? { path: value.path.replaceAll('\\','/') } : {}) }]));
await writeFile(file, JSON.stringify(config, null, 2));
console.log('Normalized local Windows output paths.');


import { createInterface } from 'node:readline';
import { MapifyClient } from './client.ts';
import { handleMapifyMessage } from './tools.ts';

const client = new MapifyClient({
  apiKey: process.env.MAPIFY_API_KEY ?? '',
  baseUrl: process.env.MAPIFY_API_BASE_URL ?? '',
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let response: Awaited<ReturnType<typeof handleMapifyMessage>>;
  try {
    response = await handleMapifyMessage(JSON.parse(line), client);
  } catch {
    response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}

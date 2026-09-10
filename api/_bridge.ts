import { handleApiRequest } from '../apps/api/src/http/handler.ts';

export const config = {
  api: {
    bodyParser: false,
  },
};

/** Web-standard boundary for signed payloads. Never touches Node's lazy req.body parser. */
export function createRawPostHandler(handleRequest: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const limit = 2 * 1024 * 1024;
    const tooLarge = () => Response.json({ error: 'Request too large' }, { status: 413 });
    if (Number(request.headers.get('content-length')) > limit) return tooLarge();
    if (request.bodyUsed) return Response.json({ error: 'Request body is unavailable' }, { status: 400 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); return tooLarge(); }
          chunks.push(value);
        }
      } catch {
        return Response.json({ error: 'Unable to read request body' }, { status: 400 });
      } finally { reader.releaseLock(); }
    }
    const rawBody = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { rawBody.set(chunk, offset); offset += chunk.byteLength; }
    return handleRequest(new Request(request, { body: rawBody }));
  };
}

function headerEntries(headers: Record<string, string | string[] | undefined>) {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value.map((entry): [string, string] => [name, entry]) : [[name, value] as [string, string]];
  });
}

function requestBody(req: { body?: unknown }) {
  if (req.body === undefined || req.body === null) return undefined;
  if (typeof req.body === 'string' || req.body instanceof Uint8Array) return req.body;
  return JSON.stringify(req.body);
}

export default async function handler(req: any, res: any) {
  const protocol = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers.host ?? 'localhost';
  const url = `${protocol}://${host}${req.url ?? '/api'}`;
  const init: RequestInit = {
    method: req.method,
    headers: headerEntries(req.headers),
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let body = requestBody(req);
    if (body === undefined && req[Symbol.asyncIterator]) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += bytes.length;
        if (size > 2 * 1024 * 1024) { res.status(413).send('Request too large'); return; }
        chunks.push(bytes);
      }
      body = Buffer.concat(chunks);
    }
    if (body !== undefined) {
      init.body = body;
    }
  }

  const request = new Request(url, init);

  const response = await handleApiRequest(request);
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));

  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

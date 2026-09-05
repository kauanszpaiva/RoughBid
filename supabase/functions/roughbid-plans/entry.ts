import { createClient } from '@supabase/supabase-js';
import { handleDocumentRequest } from '../../../apps/api/src/documents/routes.ts';
import { handleGeminiPlanRequest } from '../../../apps/api/src/ai-plan/gemini-service.ts';
import { GeminiPdfReader } from '../../../apps/api/src/ai-plan/gemini.ts';
import { OpenRouterFreePdfReader } from '../../../apps/api/src/ai-plan/openrouter.ts';
import { VercelBlobObjectStorage } from '../../../apps/api/src/storage/vercel-blob-storage.ts';

// The Supabase gateway verifies JWTs; the handlers also call getUser and enforce RLS.
Deno.serve(async (request: Request) => {
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization) return Response.json({ error: 'Authentication required' }, { status: 401 });
    const path = request.headers.get('x-roughbid-path') ?? '';
    if (!/^\/api\/(projects|documents|ai-plan-readings)\/[A-Za-z0-9/-]+$/.test(path)) return Response.json({ error: 'Not found' }, { status: 404 });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } },
    });
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) return Response.json({ error: 'Authentication required' }, { status: 401 });
    const writer = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    // Credentials travel only from the RoughBid server to its own Supabase runtime.
    // Never return them, persist them in source, or log request headers.
    const storageToken = request.headers.get('x-roughbid-storage-token');
    const geminiKey = request.headers.get('x-roughbid-gemini-key');
    const openrouterKey = request.headers.get('x-roughbid-openrouter-key');
    if (!storageToken) return Response.json({ error: 'Plan processing is not configured.' }, { status: 503 });
    const storage = new VercelBlobObjectStorage({ token: storageToken });
    const incoming = new Request(`https://roughbid.internal${path}`, {
      method: request.method, headers: { authorization, 'x-workspace-id': request.headers.get('x-workspace-id') ?? '', 'content-type': 'application/json' },
      ...(request.method === 'GET' ? {} : { body: await request.text() }),
    });
    if (path.includes('ai-plan-readings')) return await handleGeminiPlanRequest(incoming, db as never, writer as never, storage, new GeminiPdfReader(geminiKey ?? ''), { openrouter: new OpenRouterFreePdfReader(openrouterKey ?? '') });
    return await handleDocumentRequest(incoming, db as never, storage, null, writer as never);
  } catch { return Response.json({ error: 'Plan processing failed. Please retry.' }, { status: 500 }); }
});

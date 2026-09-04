import { handleApiRequest } from '../apps/api/src/http/handler.ts';

// Runs on Vercel's Edge Runtime: handleApiRequest already speaks the Web
// standard Request/Response API apps/api's route handlers are built on.
export const config = { runtime: 'edge' };

export default function handler(request: Request): Promise<Response> {
  return handleApiRequest(request);
}

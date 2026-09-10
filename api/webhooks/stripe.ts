import { createRawPostHandler } from '../_bridge.ts';
import { handleApiRequest } from '../../apps/api/src/http/handler.ts';

// Vercel's Web-standard handler bypasses the Node req.body JSON getter, whose
// parse/reserialize cycle changes the bytes Stripe signed (including whitespace).
export const POST = createRawPostHandler(handleApiRequest);

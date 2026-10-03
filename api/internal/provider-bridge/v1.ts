import { handleApiRequest } from '../../../apps/api/src/http/handler.ts';

// Keep the original bytes: the strict bridge reader rejects duplicate keys and
// enforces its own size/deadline before verifying the signature.
export const POST = handleApiRequest;

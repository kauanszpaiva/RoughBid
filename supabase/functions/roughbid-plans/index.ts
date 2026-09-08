// Retired legacy entrypoint. All paid/complimentary/pilot calls must use the
// central API with atomic authorization, quota and budget reservations.
Deno.serve(() => Response.json({
  error: 'This legacy plan endpoint has been retired. Reload RoughBid and use the current application.',
}, { status: 410, headers: { 'cache-control': 'no-store' } }));

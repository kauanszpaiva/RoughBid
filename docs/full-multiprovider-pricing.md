# Immutable Full operation pricing

New multiprovider quotes use `paid-full-v2`. Existing `paid-full-v1` contracts
retain their original model, price, hash and validation path. An invalid explicit
v2 profile cannot fall back to the old Gemini tariff.

`PAID_FULL_PROFILE_JSON` is an explicitly reviewed `full-processing-v2` snapshot.
Its `routes` object contains all seven evidence stages. Each route must match the
configured provider, exact model, input kind, reasoning effort, output limit,
timeout, price version and maximum-call attestation. Text-only models cannot
replace visual reading. V2 requires the durable bridge transport for operation
identity and reservation, including PDF-native stages. Geometry providers remain separately gated and are not included by
inference from credentials.

Each route's `tariff` supplies the worst applicable standard, uncached input and
output rates, the maximum accepted input tokens, the bounded output tokens,
additional request cost, primary-source URL, review date and expiry. The explicit
review assertions are `standardUncached`, `reasoningIncluded` and
`maximumAcceptedInput`. This configuration is an operator-reviewed snapshot;
having a URL or API key does not itself prove a rate or account capability.

When the provider documents a shared input/output context window,
`combinedContextTokenLimit` bounds `input + output`. The cost calculator maximizes
cost over that entire region, allocating capacity to the more expensive token
class first. It never substitutes an expected or artificially reduced input
size. Without the combined constraint, the two independent maxima are summed.
All billed reasoning output must be included. The route's reviewed maximum cost
must cover the resulting mathematical bound.

OpenAI routes additionally require the explicit
`explicit-cache-default-v1` request policy. This binds the serializer's explicit
cache mode, default service tier and absence of implicit cache writes; it is not
applied to old contracts merely to make a new price fit.

The company policy is read from the database. For each operation:

```
reservationUsd = max(company base reservation, reviewed maximumCallCostUsd)
reservationUsd <= current company rolling-window cap
```

The base reservation is not a per-operation spending ceiling. The configured
company cap, complimentary limits and legacy call limits are not raised. The
saved paid provider allowances equal the sum of their operation reservations;
the economic provider cost equals the sum of the reviewed maximum costs. Existing
membership margins, overhead and payment-fee policy apply to that full scope.
V2 additionally requires the explicit `PAID_FULL_OVERHEAD_BASE_POLICY=purchase`;
the configured base cents and per-page cents have no production defaults. Each
child freezes `overheadBaseCents`, `overheadPageCents` and
`overheadBasePolicy: "purchase"` in its pricing and consent hash. A standalone
quote includes one base. A combined PDF order subtracts the duplicated bases,
then applies the membership margin and one payment fee to the resulting cost.
Its exact-cent allocations retain the original child costs as weights. Every
child must share the same overhead policy. Legacy v1 prices remain unchanged.
Here `purchase` means one purchased analysis order, not a project lifetime fee.
The same source files recover their saved purchase; a new revision requires a
new quote and consent for that revision. A newly purchased analysis has its own
base overhead. Changing this mechanism does not set production overhead values.

Every physical page has four whole-page calls and twelve calls across the four
regions of three regional passes. The saved operation order matches the worker:
classification across all pages, legends/schedules across all pages, then each
page's remaining passes and regions. Pricing freezes this plan, source manifest,
routes, settings and tariff snapshots in the consent hash.

Scheduling treats each operation as indivisible and packs that saved order into
successive capacity windows, beginning with the currently available amount.
Simply dividing total cost by the cap can undercount the required windows.
The prepayment check rejects a scope that already cannot fit before its reviewed
tariff expires. This is a capacity check, not a completion deadline: competing
work can still introduce waits. Saved evidence, payment identity and uncertainty
rules remain authoritative throughout waiting and recovery.

An uncertain provider or geometry expense has no automatic expiration. It keeps
its reserved exposure until explicit reconciliation; a job becoming old or
cancelled does not release that money. A confirmed cost leaves the rolling window
only after its settlement window expires. Scheduling subtracts unresolved
exposure from future window capacity instead of assuming that tomorrow restores
the entire cap. When no release date is known, a waiting reading has no invented
resume estimate. The scanner checks capacity again and resumes only when the
same authorization and operation can actually be admitted.

Tests use explicitly synthetic tariff snapshots and never perform paid
inference. This implementation does not activate a production profile or verify
an operator's tariff declarations by itself.

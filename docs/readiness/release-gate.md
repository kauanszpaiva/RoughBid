# Exact-commit release gate

`.github/workflows/release-gate.yml` checks out the pull request's **head SHA**, rather than GitHub's generated merge SHA, and verifies `git rev-parse HEAD` before installing. Push runs check out `github.sha`. The uploaded `release-gate-<SHA>` artifact records the expected and actual SHA, event base SHA, run URL, and outcomes of locked install, typecheck, tests, build, and dependency audit. Failed or skipped required stages produce `NO-GO` evidence.

The typecheck covers API entrypoints, API/domain code, the MCP server, standalone worker, and the browser app. Tests execute separately with Node 22's TypeScript stripping; test fixtures are not substituted for runtime typechecking.

CI builds with an explicit localhost Supabase URL and a synthetic publishable key. This proves compilation and the existing server-secret bundle guard. The output is not deployed. It does **not** prove authentication, a real preview, schema readiness, Stripe, Gemini, or release authorization. Preview/runtime checks must use the approved isolated environment and record that environment against the same SHA.

Local gate commands, with Node 22 and isolated public build configuration:

```text
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

## Prisma transitive security overrides

Prisma remains pinned at `6.15.0`. Its configuration package pins vulnerable versions of two transitive dependencies. Scoped overrides under `@prisma/config` pin `deepmerge-ts` to `8.0.0` and `effect` to `3.20.0`, the patched versions in [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) and [GHSA-38f7-945m-qr2g](https://github.com/advisories/GHSA-38f7-945m-qr2g). This avoids the audit tool's suggested Prisma downgrade and does not suppress audit findings.

Deepmerge v8 changes Map merging and custom merge types; this repository uses a Prisma schema without a custom Prisma configuration/Map merger. Compatibility was checked with Prisma CLI schema validation and the existing Prisma schema tests. Future Prisma upgrades must review these overrides and remove them once the upstream dependency ranges include patched releases. Schema validation uses a dummy localhost database URL and does not apply migrations.

A passing artifact is required evidence, not release approval. Reconciliation with current `main`, isolated migration/security/recovery proof, activation controls, and the real Stripe TEST/Gemini flow remain independent gates.

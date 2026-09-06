# Local production build on Windows

Compile on the workstation and upload prebuilt output to avoid repeating application compilation in Vercel's metered build system. Hosting, archive extraction, storage and runtime usage can still incur charges under the existing account plan.

1. Use the existing authenticated Vercel CLI and run `vercel pull --environment=production --yes`.
2. Put the real public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values in `.vercel/.env.production.local`. Vercel may mask even these public fields when they were stored as sensitive variables. If so, obtain the project URL and enabled publishable key from the same Supabase project's settings or connector. Never build `[sensitive]` values. Server credentials stay configured in Vercel production and are not needed by this build.
3. On Windows, run the installed Vercel CLI entry with Node and `--require ./scripts/vercel-windows-compat.cjs`, followed by `build --prod --yes`. The shim repairs duplicated `Path`/`PATH` values within spawned child processes only; it does not change machine settings.
4. Run `node scripts/normalize-vercel-output.mjs` to normalize static override paths emitted by the Windows builder.
5. Run `vercel deploy --prebuilt --prod --skip-domain --archive=tgz --yes --no-wait`. Archive mode is required for this project's current function file count.
6. Check the deployment is ready, validate the API and authenticated app, then promote the exact tested deployment with `vercel promote <deployment-url> --yes`.

Do not replace this with a remote rebuild merely because a local build or upload failed. Diagnose the local failure first. Never publish environment values in logs, source files, frontend bundles, PRs or documentation.

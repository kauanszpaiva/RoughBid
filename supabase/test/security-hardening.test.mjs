import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('security hardening removes helper functions from public RPC surface', async () => {
  const sql = await readFile(new URL('../migrations/0002_security_hardening.sql', import.meta.url), 'utf8');
  const normalized = sql.toLowerCase();
  for (const required of [
    'create schema if not exists private',
    'alter function public.handle_new_user_profile() set schema private',
    'alter function public.add_workspace_owner_membership() set schema private',
    'alter function public.has_workspace_access(uuid) set schema private',
    'alter function public.is_workspace_owner(uuid) set schema private',
    'alter function public.has_product_access() set schema private',
    'alter function public.can_access_plan_object(text) set schema private',
    'create policy stripe_events_explicit_deny',
  ]) assert.match(normalized, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

import { buildUsageReport, USAGE_OWNER_EMAIL, USAGE_OWNER_ID, type UsageRow } from '../../../../packages/domain/src/api-usage.ts';
interface Database { auth?: { getUser(): Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string | null } | null }; error: unknown }> }; from(table: string): any }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const PAGE = 500, MAX_ROWS = 10000;
async function rows(admin: Database, table: string, columns: string, since?: string, until?: string): Promise<UsageRow[]> {
  const result: UsageRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let query = admin.from(table).select(columns).order(table === 'pilot_enrollments' ? 'user_id' : table === 'pilot_project_creations' ? 'project_id' : 'id');
    if (since) query = query.gte('created_at', since);
    if (until) query = query.lt('created_at', until);
    const page = await query.range(offset, offset + PAGE - 1);
    if (page.error || !Array.isArray(page.data)) throw new Error('Usage data unavailable');
    result.push(...page.data);
    if (page.data.length < PAGE) return result;
  }
  throw new Error('Report is too large; select a shorter period. No partial totals were returned.');
}
export async function readPilotCohort(admin: Database) {
  const result = await admin.from('pilot_cohorts').select('capacity,budget_cents,reserved_cents,enabled').eq('code', 'founding-pilot-60d').maybeSingle();
  if (result.error || !result.data || !Number.isSafeInteger(result.data.capacity) || !Number.isSafeInteger(result.data.budget_cents)) throw new Error('Pilot budget could not be verified.');
  return result.data as { capacity: number; budget_cents: number; reserved_cents: number; enabled: boolean };
}
export async function handleOwnerUsageRequest(request: Request, client: Database, admin: Database): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  try {
    const auth = await client.auth?.getUser();
    const user = auth?.data.user;
    if (auth?.error || !user) return json({ error: 'Sign in to continue.' }, 401);
    if (user.id !== USAGE_OWNER_ID || user.email?.trim().toLowerCase() !== USAGE_OWNER_EMAIL || !user.email_confirmed_at) return json({ error: 'Only the platform owner can view API usage.' }, 403);
    const role = await admin.from('profiles').select('is_platform_admin').eq('id', user.id).maybeSingle();
    if (role.error) return json({ error: 'Owner access could not be verified.' }, 503);
    if (role.data?.is_platform_admin !== true) return json({ error: 'Owner access is required.' }, 403);
    const days = Number(new URL(request.url).searchParams.get('days') ?? '60');
    if (![7, 30, 60, 90].includes(days)) return json({ error: 'Choose a 7, 30, 60 or 90 day period.' }, 400);
    const now = new Date(), since = new Date(+now - days * 864e5).toISOString(), until = now.toISOString();
    const [events, jobs, profiles, enrollments, invitations, cohorts, projects] = await Promise.all([
      rows(admin, 'api_usage_events', 'id,user_id,project_id,provider,model,operation,input_tokens,output_tokens,estimated_cost_usd,actual_cost_usd,created_at', since, until),
      rows(admin, 'plan_reading_jobs', 'id,requested_by,project_id,model,status,created_at', since, until),
      rows(admin, 'profiles', 'id,display_name'),
      rows(admin, 'pilot_enrollments', 'user_id,cohort_id,invitation_id,preset,reserved_cents,starts_at,expires_at,revoked_at'),
      rows(admin, 'pilot_invitations', 'id,email'),
      rows(admin, 'pilot_cohorts', 'id,code,capacity,budget_cents,reserved_cents,enabled'),
      // project_id is this audit table's primary key, unlike ordinary tables.
      rows(admin, 'pilot_project_creations', 'project_id,user_id,created_at', new Date(+now - 7 * 864e5).toISOString(), until),
    ]);
    return json({ ...buildUsageReport({ events, jobs, profiles, enrollments, invitations, cohorts, projects }, now), period: { days, since, until } });
  } catch { return json({ error: 'Usage could not be verified. No incomplete or zero-filled totals are shown. Try a shorter period or refresh.' }, 503); }
}

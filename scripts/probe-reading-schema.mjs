/** Read-only schema validation; LIMIT 0 prevents downloading any customer rows. */
export async function probeReadingSchema(env = process.env, fetcher = fetch) {
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_PLAN_FUNCTION || '').trim();
  let url;
  try {
    url = new URL(env.SUPABASE_URL);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password) throw new Error();
  } catch { return { status: 'unconfigured', code: 'DATABASE_CONFIGURATION' }; }
  if (!key || /masked|redacted|placeholder/i.test(key)) return { status: 'unconfigured', code: 'DATABASE_CONFIGURATION' };
  url.pathname = '/rest/v1/plan_reading_jobs';
  url.search = '';
  url.hash = '';
  url.searchParams.set('select', 'id,plan_reading_findings!plan_reading_findings_job_workspace_project_file_fkey(id)');
  url.searchParams.set('limit', '0');
  try {
    const response = await fetcher(url.toString(), {
      method: 'GET', headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && Array.isArray(body) && body.length === 0) return { status: 'available', code: 'OK' };
    const known = ['PGRST200', 'PGRST201', 'PGRST204', '42501'];
    return { status: 'unavailable', httpStatus: response.status, code: known.includes(body?.code) ? body.code : 'DATABASE_QUERY_FAILED' };
  } catch { return { status: 'unavailable', code: 'DATABASE_NETWORK' }; }
}

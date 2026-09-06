import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { presignUrl } from '@vercel/blob';

test('browser CSP permits the installed Blob SDK upload endpoint without opening other Vercel paths', async () => {
  const config = JSON.parse(await readFile(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const csp = config.headers.flatMap((entry: any) => entry.headers)
    .find((header: any) => header.key.toLowerCase() === 'content-security-policy').value as string;
  const sources = csp.split(';').map(value => value.trim()).find(value => value.startsWith('connect-src '))!.split(/\s+/).slice(1);

  // Local fixture only: presignUrl is an HMAC operation; it makes no API call.
  // This fabricated delegation cannot authorize an upload to any real store.
  const pathname = 'workspace-fixture/project-fixture/file-fixture/source.pdf';
  const validUntil = Date.now() + 300_000;
  const delegationToken = Buffer.from(JSON.stringify({
    pathname, operations: ['put'], validUntil, allowedContentTypes: ['application/pdf'],
  })).toString('base64url') + '.invalid-fixture-signature';
  const { presignedUrl } = await presignUrl({
    delegationToken, clientSigningToken: 'local-unit-signing-key', validUntil,
  }, { operation: 'put', pathname, validUntil, allowedContentTypes: ['application/pdf'], addRandomSuffix: false, allowOverwrite: false });
  const uploadUrl = new URL(presignedUrl);
  assert.equal(uploadUrl.origin, 'https://vercel.com');
  assert.equal(uploadUrl.pathname, '/api/blob/');
  assert.equal(uploadUrl.searchParams.get('pathname'), pathname);
  assert.ok(sources.includes(uploadUrl.origin + uploadUrl.pathname),
    'The Blob control endpoint must be allowed separately from object-storage subdomains.');
  assert.ok(sources.includes('https://*.blob.vercel-storage.com'));
  assert.ok(!sources.includes('https://vercel.com') && !sources.includes('https://vercel.com/') && !sources.includes('https:') && !sources.includes('*'));
});

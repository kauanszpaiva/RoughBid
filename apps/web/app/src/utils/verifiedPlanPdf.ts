const maximumBytes = 50 * 1024 * 1024;
/** The overlay must refer to the exact PDF revision used by the saved run. */
export async function downloadVerifiedPlanPdf(preview: { url: string; method: 'GET'; headers: Record<string, string> }, expectedSha256: string,
  signal: AbortSignal, fetchSource: typeof fetch = fetch): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('The saved PDF fingerprint is unavailable.');
  const response = await fetchSource(preview.url, { method: preview.method, headers: preview.headers, signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`The private PDF could not be loaded (${response.status}).`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximumBytes) throw new Error('This PDF exceeds the 50 MB review preview limit.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) throw new Error('This PDF exceeds the 50 MB review preview limit.');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('The stored source is not a PDF.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('The PDF revision differs from the saved reading. Reload the source before measuring.');
  return bytes;
}

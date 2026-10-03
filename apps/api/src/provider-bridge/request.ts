import { BRIDGE_HEADER_NAMES, BRIDGE_PATH, BRIDGE_PROTOCOL, PHOTO_BRIDGE_PROTOCOL, BridgeError, type BridgeCommand } from './protocol.ts';
import { verifyBridgeSignature, type BridgeAuthConfig } from './auth.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const fail = (): never => { throw new BridgeError('bridge_request_invalid', 400); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail();
}
/** Closed command grammar: objects, strings and safe integers only. Decoded duplicate keys are rejected before JSON.parse can discard them. */
export function parseBridgeCommand(text: string): BridgeCommand {
  if (Buffer.byteLength(text) > 16_384) throw new BridgeError('bridge_body_too_large', 413);
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? '\u0000')) offset++; };
  const string = (): string => {
    const token = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
    token.lastIndex = offset; const match = token.exec(text); if (!match) return fail(); offset = token.lastIndex;
    const decoded: string = JSON.parse(match[0]);
    // JCS rejects lone surrogates instead of silently normalizing their bytes.
    for (let i = 0; i < decoded.length; i++) {
      const n = decoded.charCodeAt(i);
      if (n >= 0xd800 && n <= 0xdbff) { const next = decoded.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); }
      else if (n >= 0xdc00 && n <= 0xdfff) fail();
    }
    return decoded;
  };
  const read = (depth: number): unknown => {
    whitespace(); if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      if (depth >= 2) return fail(); offset++; whitespace(); const result: Record<string, unknown> = Object.create(null);
      if (text[offset] === '}') { offset++; return result; }
      while (offset < text.length) {
        const key = string(); if (Object.hasOwn(result, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) return fail();
        whitespace(); if (text[offset++] !== ':') return fail(); result[key] = read(depth + 1); whitespace();
        if (text[offset] === '}') { offset++; return result; }
        if (text[offset++] !== ',') return fail(); whitespace();
      }
      return fail();
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = offset; const match = number.exec(text); if (!match) return fail(); offset = number.lastIndex;
    const n = Number(match[0]); if (!Number.isSafeInteger(n) || Object.is(n, -0)) return fail(); return n;
  };
  const value = read(0); whitespace(); if (offset !== text.length || !object(value)) return fail();
  const base = ['action', 'protocol', 'run_id', 'operation_id', 'worker'];
  if (value.action === 'submit_stage') {
    keys(value, [...base, 'expected_stage_version', 'expected_approved_contract_sha256', 'expected_operation_spec_sha256']);
    if (!Number.isSafeInteger(value.expected_stage_version) || Number(value.expected_stage_version) < 1
      || !SHA.test(String(value.expected_approved_contract_sha256)) || !SHA.test(String(value.expected_operation_spec_sha256))) return fail();
  } else if (value.action === 'get_operation' || value.action === 'reconcile_operation') keys(value, base);
  else return fail();
  if (value.protocol !== BRIDGE_PROTOCOL && value.protocol !== PHOTO_BRIDGE_PROTOCOL || !UUID.test(String(value.run_id)) || !UUID.test(String(value.operation_id)) || !object(value.worker)) return fail();
  keys(value.worker, ['worker_id', 'worker_generation', 'lease_id', 'fence']);
  for (const key of ['worker_id', 'worker_generation', 'lease_id']) if (!UUID.test(String(value.worker[key]))) return fail();
  if (typeof value.worker.fence !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.worker.fence)
    || BigInt(value.worker.fence) > 9223372036854775807n) return fail();
  return value as unknown as BridgeCommand;
}
/** Transport authentication only: intentionally has no adapter, fetch, ledger or dispatch hook. */
export async function authenticateBridgeRequest(request: Request, config: BridgeAuthConfig, nowSeconds: number, maxBodyBytes = 16_384, bodyReadTimeoutMs = 5_000) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== BRIDGE_PATH || url.search || url.hash
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 16_384
    || !Number.isSafeInteger(bodyReadTimeoutMs) || bodyReadTimeoutMs < 1 || bodyReadTimeoutMs > 30_000) return fail();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBodyBytes)) throw new BridgeError('bridge_body_too_large', 413);
  if (!request.body) return fail();
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let rejectRead: (error: BridgeError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectRead = reject; });
  const abortRead = () => { rejectRead(new BridgeError('bridge_request_invalid', 400)); void reader.cancel().catch(() => {}); };
  const timeout = setTimeout(abortRead, bodyReadTimeoutMs);
  request.signal.addEventListener('abort', abortRead, { once: true });
  if (request.signal.aborted) abortRead();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]); if (done) break; size += value.byteLength;
      if (size > maxBodyBytes) { void reader.cancel().catch(() => {}); throw new BridgeError('bridge_body_too_large', 413); } chunks.push(value);
    }
  } catch (error) { if (error instanceof BridgeError) throw error; return fail(); }
  finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abortRead); reader.releaseLock(); }
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); } catch { return fail(); }
  const command = parseBridgeCommand(text);
  const proof = verifyBridgeSignature(command, {
    timestamp: request.headers.get(BRIDGE_HEADER_NAMES.timestamp) ?? '', nonce: request.headers.get(BRIDGE_HEADER_NAMES.nonce) ?? '',
    signature: request.headers.get(BRIDGE_HEADER_NAMES.signature) ?? '',
  }, config, nowSeconds);
  return { command, ...proof };
}

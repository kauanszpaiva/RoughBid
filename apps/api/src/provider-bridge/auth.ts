import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRIDGE_DOMAIN, BRIDGE_PATH, BridgeError, type BridgeCommand } from './protocol.ts';

/** Production must inject an audited RFC8785 implementation. No JSONB stringify fallback. */
export type Canonicalize = (value: unknown) => string;
export interface SignedHeaders { timestamp: string; nonce: string; signature: string }
export interface BridgeAuthConfig {
  existingSecret: Uint8Array;
  /** Deployment-owned context, never a field/header supplied by the worker. */
  trustedEnvironmentContext: string;
  canonicalize: Canonicalize;
  maxSkewSeconds: number;
}
export const bridgeSha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function deriveKey(config: BridgeAuthConfig): Buffer {
  if (config.existingSecret.byteLength < 16 || !config.trustedEnvironmentContext
    || config.trustedEnvironmentContext.length > 200 || /[\r\n]/.test(config.trustedEnvironmentContext)
    || Buffer.from(config.existingSecret).toString('utf8').includes('[SENSITIVE]')
    || !Number.isSafeInteger(config.maxSkewSeconds) || config.maxSkewSeconds < 1 || config.maxSkewSeconds > 300) {
    throw new BridgeError('bridge_auth_unconfigured', 503);
  }
  const salt = createHash('sha256').update(`${BRIDGE_DOMAIN}\n${config.trustedEnvironmentContext}`).digest();
  return Buffer.from(hkdfSync('sha256', config.existingSecret, salt, Buffer.from(`${BRIDGE_DOMAIN}/hmac`), 32));
}
function message(bodyHash: string, timestamp: string, nonce: string): string {
  return [BRIDGE_DOMAIN, 'POST', BRIDGE_PATH, timestamp, nonce, bodyHash].join('\n');
}
function canonicalBody(command: BridgeCommand, canonicalize: Canonicalize): string {
  try { const body = canonicalize(command); if (typeof body !== 'string' || !body) throw new Error(); return body; }
  catch { throw new BridgeError('bridge_auth_unconfigured', 503); }
}
export function signBridgeCommand(command: BridgeCommand, config: BridgeAuthConfig, nowSeconds: number): { canonical_body: string; headers: SignedHeaders } {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1_000_000_000 || nowSeconds > 999_999_999_999) throw new BridgeError('bridge_auth_expired', 401);
  const canonical_body = canonicalBody(command, config.canonicalize);
  const timestamp = String(nowSeconds), nonce = randomBytes(32).toString('base64url');
  const key = deriveKey(config);
  try { return { canonical_body, headers: { timestamp, nonce,
    signature: createHmac('sha256', key).update(message(bridgeSha256(canonical_body), timestamp, nonce)).digest('base64url') } }; }
  finally { key.fill(0); }
}
/** Result still needs durable nonce registration AND database run/lease authorization. */
export function verifyBridgeSignature(command: BridgeCommand, headers: SignedHeaders, config: BridgeAuthConfig, nowSeconds: number): {
  command_body_sha256: string; nonce_sha256: string;
} {
  if (!/^[1-9][0-9]{9,11}$/.test(headers.timestamp) || !/^[A-Za-z0-9_-]{43}$/.test(headers.nonce)
    || !/^[A-Za-z0-9_-]{43}$/.test(headers.signature)) throw new BridgeError('bridge_auth_invalid', 401);
  const key = deriveKey(config);
  try {
    const signedAt = Number(headers.timestamp);
    if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - signedAt) > config.maxSkewSeconds) throw new BridgeError('bridge_auth_expired', 401);
    const mac = Buffer.from(headers.signature, 'base64url'), nonce = Buffer.from(headers.nonce, 'base64url');
    if (mac.length !== 32 || nonce.length !== 32 || mac.toString('base64url') !== headers.signature
      || nonce.toString('base64url') !== headers.nonce) throw new BridgeError('bridge_auth_invalid', 401);
    const command_body_sha256 = bridgeSha256(canonicalBody(command, config.canonicalize));
    const expected = createHmac('sha256', key).update(message(command_body_sha256, headers.timestamp, headers.nonce)).digest();
    if (!timingSafeEqual(expected, mac)) throw new BridgeError('bridge_auth_invalid', 401);
    return { command_body_sha256, nonce_sha256: bridgeSha256(nonce) };
  } finally { key.fill(0); }
}

/** Mutual proof for the readonly handshake and operation replies; bound to this exact request. */
export function bridgeResponseProof(body: string, requestBodyHash: string, nonceHash: string, config: BridgeAuthConfig): string {
  const key = deriveKey(config);
  try { return createHmac('sha256', key).update([`${BRIDGE_DOMAIN}/response`, requestBodyHash, nonceHash, bridgeSha256(body)].join('\n')).digest('base64url'); }
  finally { key.fill(0); }
}
export function verifyBridgeResponseProof(body: string, requestBodyHash: string, nonceHash: string, proof: string, config: BridgeAuthConfig): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new BridgeError('bridge_auth_invalid', 401);
  const expected = Buffer.from(bridgeResponseProof(body, requestBodyHash, nonceHash, config), 'base64url'), actual = Buffer.from(proof, 'base64url');
  if (actual.length !== expected.length || actual.toString('base64url') !== proof || !timingSafeEqual(expected, actual)) throw new BridgeError('bridge_auth_invalid', 401);
}

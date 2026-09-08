import { createHash, createHmac } from 'node:crypto';

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicAssetBaseUrl?: string;
}

export interface PresignedObjectRequest {
  url: string;
  method: 'GET' | 'PUT' | 'HEAD';
  headers: Record<string, string>;
  expiresAt: string;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();

export function loadObjectStorageConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ObjectStorageConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const endpoint = required('OBJECT_STORAGE_ENDPOINT').replace(/\/$/, '');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('OBJECT_STORAGE_ENDPOINT must use HTTPS');
  return {
    endpoint,
    region: env.OBJECT_STORAGE_REGION?.trim() || 'auto',
    bucket: required('OBJECT_STORAGE_BUCKET'),
    accessKeyId: required('OBJECT_STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: required('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    ...(env.OBJECT_STORAGE_PUBLIC_ASSET_URL?.trim() ? { publicAssetBaseUrl: env.OBJECT_STORAGE_PUBLIC_ASSET_URL.trim().replace(/\/$/, '') } : {}),
  };
}

/** AWS Signature V4 query signing, compatible with S3 and Cloudflare R2. */
export class S3ObjectStorage {
  private readonly config: ObjectStorageConfig;
  private readonly now: () => Date;
  constructor(config: ObjectStorageConfig, now = () => new Date()) { this.config = config; this.now = now; }

  presign(method: 'GET' | 'PUT' | 'HEAD', key: string, options: { expiresIn?: number; contentType?: string; downloadName?: string; maximumSizeInBytes?: number } = {}): PresignedObjectRequest {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('Invalid object key');
    const expiresIn = Math.min(Math.max(Math.floor(options.expiresIn ?? 300), 1), 900);
    const date = this.now();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const endpoint = new URL(this.config.endpoint);
    const path = `/${encode(this.config.bucket)}/${key.split('/').map(encode).join('/')}`;
    const headers: Record<string, string> = {};
    const signedHeaders = ['host'];
    if (method === 'PUT' && options.contentType) { headers['content-type'] = options.contentType; signedHeaders.push('content-type'); }
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': signedHeaders.sort().join(';'),
    };
    if (options.downloadName) query['response-content-disposition'] = `attachment; filename="${options.downloadName.replace(/["\r\n]/g, '_')}"`;
    const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const canonicalHeaders = signedHeaders.sort().map((name) => `${name}:${name === 'host' ? endpoint.host : headers[name]}\n`).join('');
    const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return { url: `${endpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`, method, headers, expiresAt: new Date(date.getTime() + expiresIn * 1000).toISOString() };
  }

  assetUrl(key: string): string | null {
    return this.config.publicAssetBaseUrl ? `${this.config.publicAssetBaseUrl}/${key.split('/').map(encode).join('/')}` : null;
  }
}

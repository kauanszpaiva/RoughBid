import { issueSignedToken, presignUrl } from '@vercel/blob';
import type { PresignedObjectRequest } from './object-storage.ts';

export interface VercelBlobStorageConfig {
  token: string;
}

const methodFor = (operation: 'get' | 'put' | 'head' | 'delete'): PresignedObjectRequest['method'] => {
  if (operation === 'put') return 'PUT';
  if (operation === 'head') return 'HEAD';
  return 'GET';
};

export function loadVercelBlobStorageConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): VercelBlobStorageConfig {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');
  return { token };
}

export class VercelBlobObjectStorage {
  private readonly config: VercelBlobStorageConfig;

  constructor(config: VercelBlobStorageConfig) {
    this.config = config;
  }

  async presign(method: PresignedObjectRequest['method'], key: string, options: { expiresIn?: number; contentType?: string; downloadName?: string; maximumSizeInBytes?: number } = {}): Promise<PresignedObjectRequest> {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('Invalid object key');
    const operation = method === 'PUT' ? 'put' : method === 'HEAD' ? 'head' : 'get';
    const expiresIn = Math.min(Math.max(Math.floor(options.expiresIn ?? 300), 1), 900);
    const validUntil = Date.now() + expiresIn * 1000;
    const maximumSizeInBytes = options.maximumSizeInBytes;
    if (maximumSizeInBytes !== undefined && (!Number.isSafeInteger(maximumSizeInBytes) || maximumSizeInBytes < 1)) throw new Error('Invalid upload size limit');
    const token = await issueSignedToken({
      pathname: key,
      operations: [operation],
      validUntil,
      ...(operation === 'put' && maximumSizeInBytes ? { maximumSizeInBytes } : {}),
      ...(operation === 'put' && options.contentType ? { allowedContentTypes: [options.contentType] } : {}),
      token: this.config.token,
    });
    const signed = await presignUrl(token, {
      operation,
      pathname: key,
      access: 'private',
      validUntil,
      ...(operation === 'put' && maximumSizeInBytes ? { maximumSizeInBytes } : {}),
      ...(operation === 'put' && options.contentType ? { allowedContentTypes: [options.contentType] } : {}),
      addRandomSuffix: false,
      allowOverwrite: false,
      useCache: false,
    });
    return {
      url: signed.presignedUrl,
      method: methodFor(operation),
      headers: operation === 'put' && options.contentType ? { 'content-type': options.contentType } : {},
      expiresAt: new Date(validUntil).toISOString(),
    };
  }

  assetUrl(_key: string): string | null {
    return null;
  }
}

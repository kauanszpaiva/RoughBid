import test from 'node:test';
import assert from 'node:assert/strict';
import { loadObjectStorageConfig, S3ObjectStorage } from '../src/storage/object-storage.ts';

test('loads an S3-compatible configuration without exposing credentials', () => {
  const config = loadObjectStorageConfig({ OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com', OBJECT_STORAGE_BUCKET: 'plans', OBJECT_STORAGE_ACCESS_KEY_ID: 'access', OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret' });
  assert.equal(config.region, 'auto');
  const request = new S3ObjectStorage(config, () => new Date('2026-09-02T12:00:00Z')).presign('PUT', 'workspace/project/file/source.pdf', { contentType: 'application/pdf' });
  assert.equal(request.method, 'PUT');
  assert.equal(request.headers['content-type'], 'application/pdf');
  assert.match(request.url, /X-Amz-Signature=/);
  assert.equal(request.url.includes('secret'), false);
  assert.equal(request.expiresAt, '2026-09-02T12:05:00.000Z');
});

test('download signatures are short lived and sanitize response filenames', () => {
  const storage = new S3ObjectStorage({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'plans', accessKeyId: 'key', secretAccessKey: 'secret' }, () => new Date('2026-09-02T12:00:00Z'));
  const request = storage.presign('GET', 'a/b.pdf', { expiresIn: 5000, downloadName: 'plan"\r\n.pdf' });
  assert.equal(request.expiresAt, '2026-09-02T12:15:00.000Z');
  assert.equal(decodeURIComponent(request.url).includes('\r'), false);
  assert.equal(decodeURIComponent(request.url).includes('\n'), false);
});

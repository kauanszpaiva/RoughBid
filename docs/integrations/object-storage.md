# Object storage and PDF processing

RoughBid stores original plans in a private AWS S3 or Cloudflare R2 bucket. The API creates five-minute Signature V4 PUT URLs, so PDF bytes travel directly from the browser to object storage and storage credentials never reach the client. Downloads use independent one-minute GET URLs.

## Infrastructure

1. Create a private bucket and a least-privilege server credential scoped to that bucket.
2. Configure bucket CORS to allow `PUT` and `GET` from `APP_URL`, the `Content-Type` request header, and no wildcard production origins.
3. Set the `OBJECT_STORAGE_*` variables documented in `.env.example`. For R2 use the account S3 endpoint and region `auto`; for AWS use the bucket's regional S3 endpoint and region.
4. Provision Redis, set `REDIS_URL`, install Poppler (`pdfinfo` and `pdftoppm`) in the worker image, and run the BullMQ worker separately from the web process.
5. Apply migration `0004_document_processing.sql`.

## Upload lifecycle

The API validates the declared PDF type, extension, and size before creating an `uploading` record and presigning its immutable `workspace/project/file/source.pdf` key. After the client PUT succeeds, it calls completion. The API verifies the stored object's content type and exact length with a signed HEAD request, changes the record to `queued`, and enqueues an idempotent job keyed by file ID with three exponential-backoff attempts. A retry can safely re-enqueue a record left queued by a transient Redis failure.

The worker downloads the private original, extracts PDF title, author, and page count with `pdfinfo`, renders progressive JPEG pages at a maximum dimension of 2000 pixels with `pdftoppm`, uploads them, and records each asset. Processing state progresses through `queued`, `processing`, and `ready`; a bounded diagnostic is retained when processing fails. Originals remain private and retrievable only through a signed URL.

Workers should run with the service-role database credential. Browser users receive only SELECT access to page records through workspace and product-entitlement RLS; they cannot forge processing results.

import 'server-only';
import { readRuntimeConfig } from '@intradocs/core/config';
import { createBlobStore } from '@intradocs/core/storage';
import type { BlobStore } from '@intradocs/core/ports';
let instance: BlobStore | undefined;
/** The configured store: a private directory, or an S3 bucket (one client per process). */
export function getStorage(): BlobStore {
  if (!instance) {
    const c = readRuntimeConfig(process.env);
    instance = createBlobStore(c.storage, c.rootDir);
  }
  return instance;
}

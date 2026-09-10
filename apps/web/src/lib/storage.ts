import 'server-only';
import path from 'node:path';
import { readRuntimeConfig } from '@intradocs/core/config';
import { LocalBlobStore } from '@intradocs/core/storage';
export function getStorage() {
  const c = readRuntimeConfig(process.env);
  return new LocalBlobStore(path.resolve(c.rootDir, c.storageRoot));
}

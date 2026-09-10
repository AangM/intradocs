import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@intradocs/core';
import { diffLines, type DiffResult } from '@intradocs/core/diff';
import {
  readVersionPair,
  readSourceArtifacts,
  recordRollback,
  RollbackError,
  type VersionForDiff,
} from '@intradocs/db/versions';
import { getStorage } from './storage.ts';

export interface VersionComparison {
  left: VersionForDiff;
  right: VersionForDiff;
  diff: DiffResult;
}

/**
 * Compares two versions of one document.
 *
 * Both sides come back from the database only if this actor may read both, and the query
 * requires them to share a document, so there is no arrangement of parameters that puts
 * unauthorised text on screen. The bytes are then verified against the recorded hash
 * before being diffed: a corrupted artifact fails rather than being shown as a change.
 */
export async function compareVersions(
  actor: Actor,
  documentId: string,
  leftId: string,
  rightId: string,
): Promise<VersionComparison | null> {
  const pair = await readVersionPair(actor.id, documentId, leftId, rightId);
  if (!pair) return null;
  const storage = getStorage();
  const [leftBytes, rightBytes] = await Promise.all([
    storage.read(pair.left.markdownKey, pair.left.markdownSha256),
    storage.read(pair.right.markdownKey, pair.right.markdownSha256),
  ]);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    left: pair.left,
    right: pair.right,
    diff: diffLines(decoder.decode(leftBytes), decoder.decode(rightBytes)),
  };
}

/**
 * Restores an earlier approved version as a new draft.
 *
 * The artifacts are copied first, then recorded. If the copy succeeds and the record
 * fails, the copied blobs are unreferenced and the existing orphan cleanup removes them;
 * the reverse cannot happen, because nothing is recorded until the bytes exist.
 */
export async function restoreVersion(
  actor: Actor,
  documentId: string,
  sourceVersionId: string,
): Promise<{ versionId: string; label: string }> {
  const source = await readSourceArtifacts(actor.id, documentId, sourceVersionId);
  if (!source) throw new RollbackError('Versi tidak tersedia.', 'rollback_denied', 404);
  const newVersionId = randomUUID();
  const prefix = `documents/${documentId}/versions/${newVersionId}`;
  const markdownKey = `${prefix}/content.md`;
  const originalKey = `${prefix}/original.${source.sourceFormat.toLowerCase()}`;
  const provenanceKey = `${prefix}/provenance.json`;
  const storage = getStorage();
  // Read with the expected hash, write immutably: the copy is verified on both ends, so a
  // silent corruption cannot become a draft that claims to match the source version.
  for (const [from, to, hash] of [
    [source.markdownKey, markdownKey, source.markdownSha256],
    [source.originalKey, originalKey, source.originalSha256],
    [source.provenanceKey, provenanceKey, source.provenanceSha256],
  ] as const) {
    const bytes = await storage.read(from, hash);
    await storage.putImmutable(to, bytes);
  }
  return recordRollback(actor.id, {
    documentId,
    sourceVersionId,
    newVersionId,
    markdownKey,
    originalKey,
    provenanceKey,
  });
}

export { RollbackError };

import { randomUUID } from 'node:crypto';
import type { Actor } from '@intradocs/core';
import {
  UPLOAD_LIMITS,
  UploadError,
  draftSlug,
  uploadFingerprint,
  type DraftMetadata,
  type UploadFile,
  type ConvertedText,
} from '@intradocs/core/uploads';
import type { ScanEvidence } from '@intradocs/core/clamav';
import type {
  DraftRepository,
  UploadClaim,
  DraftArtifacts,
  DraftResult,
} from '@intradocs/core/draft-ingestion';
import { withActor, type ScopedDatabase } from './index.ts';
import { AccessDenied } from './queries.ts';
type RequestRow = {
  owner_id: string;
  request_id: string;
  payload_hash: string;
  state: 'processing' | 'failed' | 'complete';
  lease_token: string;
  lease_until: Date;
  document_id: string;
  version_id: string;
  attempts: number;
  created_at: Date;
  updated_at: Date;
};
async function storageAvailable(scope: ScopedDatabase): Promise<void> {
  await scope.client.query('SELECT pg_advisory_xact_lock_shared(719281,1)');
  const { rows } = await scope.client.query<{ available: boolean }>(
    'SELECT pg_try_advisory_xact_lock_shared(719283,1) AS available',
  );
  if (!rows[0]?.available)
    throw new UploadError(
      'storage_maintenance',
      'Pemeliharaan storage berlangsung. Coba kembali sebentar lagi.',
      503,
      15,
    );
}
async function canUpload(scope: ScopedDatabase, categoryId: string): Promise<void> {
  const { rows } = await scope.client.query<{ allowed: boolean }>(
    'SELECT app.can_upload_to($1::uuid) AS allowed',
    [categoryId],
  );
  if (!rows[0]?.allowed) throw new AccessDenied();
}
async function previousResult(scope: ScopedDatabase, row: RequestRow): Promise<DraftResult> {
  const { rows } = await scope.client.query<{ slug: string }>(
    'SELECT slug FROM app.documents WHERE id=$1',
    [row.document_id],
  );
  if (!rows[0])
    throw new UploadError(
      'unavailable_draft',
      'Draft sebelumnya tidak lagi tersedia dalam akses Anda.',
      409,
    );
  return {
    documentId: row.document_id,
    versionId: row.version_id,
    slug: rows[0].slug,
    reused: true,
  };
}
export class PostgresDraftRepository implements DraftRepository {
  async reserve(actor: Actor, requestId: string, payloadHash: string, metadata: DraftMetadata) {
    return withActor(actor.id, async (scope) => {
      const c = scope.client;
      await storageAvailable(scope);
      await c.query('SELECT pg_advisory_xact_lock(719282,hashtext($1))', [actor.id]);
      await canUpload(scope, metadata.categoryId);
      const floor = (
        await c.query<{ floor: number }>(
          'SELECT app.classification_rank(app.category_floor($1)) AS floor',
          [metadata.categoryId],
        )
      ).rows[0]!.floor;
      if (
        ['public', 'internal', 'restricted', 'confidential'].indexOf(metadata.classification) + 1 <
        floor
      )
        throw new UploadError(
          'classification_floor',
          'Klasifikasi lebih rendah daripada aturan kategori.',
          422,
        );
      const exact = await c.query<RequestRow>(
        'SELECT * FROM app.upload_requests WHERE owner_id=app.actor_id() AND request_id=$1',
        [requestId],
      );
      if (exact.rows[0] && exact.rows[0].payload_hash !== payloadHash)
        throw new UploadError(
          'idempotency_conflict',
          'Permintaan ini sudah digunakan untuk isi lain. Pilih kembali berkas atau ubah metadata untuk permintaan baru.',
          409,
        );
      const matching =
        exact.rows[0] ??
        (
          await c.query<RequestRow>(
            'SELECT * FROM app.upload_requests WHERE owner_id=app.actor_id() AND payload_hash=$1',
            [payloadHash],
          )
        ).rows[0];
      if (matching?.state === 'complete')
        return { kind: 'complete' as const, result: await previousResult(scope, matching) };
      if (metadata.documentId) {
        const base = await c.query(
          'SELECT v.id,d.category_id,d.classification FROM app.documents d JOIN app.document_versions v ON v.document_id=d.id WHERE d.id=$1 AND d.owner_id=app.actor_id() AND NOT d.withdrawn ORDER BY v.version_number DESC LIMIT 1',
          [metadata.documentId],
        );
        if (!base.rows[0]) throw new AccessDenied();
        if (
          base.rows[0].id !== metadata.baseVersionId ||
          base.rows[0].category_id !== metadata.categoryId ||
          base.rows[0].classification !== metadata.classification
        )
          throw new UploadError(
            'revision_conflict',
            'Versi sudah berubah atau kategori/klasifikasi tidak sama. Muat ulang.',
            409,
          );
      }
      const busy = await c.query(
        "SELECT 1 FROM app.upload_requests WHERE owner_id=app.actor_id() AND state='processing' AND lease_until>now() LIMIT 1",
      );
      if (busy.rowCount)
        throw new UploadError(
          'upload_busy',
          'Masih ada satu unggahan diproses. Tunggu lalu coba lagi.',
          409,
          5,
        );
      const rate = await c.query<{ total: string }>(
        "SELECT coalesce(sum(attempts),0)::text AS total FROM app.upload_requests WHERE owner_id=app.actor_id() AND updated_at>now()-interval '1 hour'",
      );
      if (Number(rate.rows[0]?.total ?? 0) >= UPLOAD_LIMITS.perHour)
        throw new UploadError(
          'upload_rate_limit',
          'Batas unggahan per jam tercapai. Coba kembali nanti.',
          429,
          3600,
        );
      const drafts = await c.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM app.documents WHERE owner_id=app.actor_id() AND current_version_id IS NULL',
      );
      if (Number(drafts.rows[0]?.total ?? 0) >= UPLOAD_LIMITS.ownedDrafts)
        throw new UploadError(
          'draft_quota',
          'Batas draft lokal tercapai. Minta bantuan pengelola sebelum melanjutkan.',
          429,
          3600,
        );
      const leaseToken = randomUUID(),
        documentId = matching?.document_id ?? metadata.documentId ?? randomUUID(),
        versionId = randomUUID();
      const key = matching?.request_id ?? requestId;
      if (matching) {
        if (
          matching.attempts >= UPLOAD_LIMITS.maxAttempts &&
          matching.updated_at.getTime() > Date.now() - 3600000
        )
          throw new UploadError(
            'upload_attempt_limit',
            'Batas percobaan file ini tercapai. Periksa pemindai dan coba kembali setelah satu jam.',
            429,
            3600,
          );
        await c.query(
          `UPDATE app.upload_requests SET state='processing',lease_token=$1,lease_until=now()+interval '300 seconds',version_id=$2,
     attempts=CASE WHEN updated_at<now()-interval '1 hour' THEN 1 ELSE attempts+1 END,error_code=NULL,updated_at=now()
     WHERE owner_id=app.actor_id() AND request_id=$3`,
          [leaseToken, versionId, key],
        );
      } else {
        await c.query(
          `INSERT INTO app.upload_requests(owner_id,request_id,payload_hash,category_id,state,lease_token,lease_until,document_id,version_id)
     VALUES(app.actor_id(),$1,$2,$3,'processing',$4,now()+interval '300 seconds',$5,$6)`,
          [key, payloadHash, metadata.categoryId, leaseToken, documentId, versionId],
        );
      }
      return {
        kind: 'claimed' as const,
        claim: {
          ownerId: actor.id,
          requestId: key,
          leaseToken,
          documentId,
          versionId,
          payloadHash,
        },
      };
    });
  }
  async complete(
    actor: Actor,
    claim: UploadClaim,
    metadata: DraftMetadata,
    file: UploadFile,
    converted: ConvertedText,
    artifacts: DraftArtifacts,
    evidence: ScanEvidence,
  ): Promise<DraftResult> {
    return withActor(actor.id, async (scope) => {
      if (
        claim.ownerId !== actor.id ||
        claim.payloadHash !==
          uploadFingerprint(
            file,
            metadata,
            (artifacts.attachments ?? []).map((a) => ({
              name: a.name,
              format: a.format as UploadFile['format'],
              sha256: a.sha256,
            })),
          )
      )
        throw new UploadError(
          'claim_mismatch',
          'Permintaan tidak sesuai dengan lease upload.',
          409,
        );
      const c = scope.client;
      await storageAvailable(scope);
      await c.query('SELECT pg_advisory_xact_lock(719282,hashtext($1))', [actor.id]);
      await canUpload(scope, metadata.categoryId);
      const floor = (
        await c.query<{ floor: number }>(
          'SELECT app.classification_rank(app.category_floor($1)) AS floor',
          [metadata.categoryId],
        )
      ).rows[0]!.floor;
      if (
        ['public', 'internal', 'restricted', 'confidential'].indexOf(metadata.classification) + 1 <
        floor
      )
        throw new UploadError(
          'classification_floor',
          'Klasifikasi lebih rendah daripada aturan kategori.',
          422,
        );
      const { rows } = await c.query<RequestRow>(
        "SELECT * FROM app.upload_requests WHERE owner_id=app.actor_id() AND request_id=$1 AND state='processing' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
        [claim.requestId, claim.leaseToken],
      );
      const row = rows[0];
      if (
        !row ||
        row.payload_hash !== claim.payloadHash ||
        row.document_id !== claim.documentId ||
        row.version_id !== claim.versionId
      )
        throw new UploadError(
          'lease_expired',
          'Percobaan upload ini sudah kedaluwarsa; coba lagi dengan berkas yang sama.',
          409,
          1,
        );
      const owner = await c.query<{ name: string }>(
        'SELECT name FROM app.profiles WHERE id=app.actor_id() AND active',
      );
      if (!owner.rows[0]) throw new AccessDenied();
      const attachmentSnapshot = (artifacts.attachments ?? []).map((a) => ({
        ordinal: a.ordinal,
        name: a.name,
        format: a.format,
        key: a.original.key,
        sha256: a.sha256,
        bytes: a.original.size,
        scan: a.evidence,
        mapping: a.mapping,
      }));
      const snapshot = attachmentSnapshot.length
        ? { ...metadata, attachments: attachmentSnapshot }
        : metadata;
      async function attach() {
        for (const a of attachmentSnapshot)
          await c.query(
            `INSERT INTO app.version_attachments(version_id,ordinal,name,source_format,original_key,original_sha256,original_bytes,scan_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
              claim.versionId,
              a.ordinal,
              a.name,
              a.format,
              a.key,
              a.sha256,
              a.bytes,
              JSON.stringify(a.scan),
            ],
          );
      }
      if (metadata.documentId) {
        const artifact = {
          name: file.name,
          format: file.format,
          pipeline: converted.pipeline ?? 'text-v1',
          originalKey: artifacts.original.key,
          originalHash: artifacts.original.sha256,
          originalBytes: artifacts.original.size,
          markdownKey: artifacts.markdown.key,
          markdownHash: artifacts.markdown.sha256,
          markdownBytes: artifacts.markdown.size,
          provenanceKey: artifacts.provenance.key,
          provenanceHash: artifacts.provenance.sha256,
        };
        const result = await c.query<{ slug: string }>(
          'SELECT app.commit_revision($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) AS slug',
          [
            metadata.baseVersionId,
            claim.versionId,
            claim.requestId,
            claim.leaseToken,
            JSON.stringify(snapshot),
            JSON.stringify(artifact),
            JSON.stringify(evidence),
          ],
        );
        await attach();
        return {
          documentId: claim.documentId,
          versionId: claim.versionId,
          slug: result.rows[0]!.slug,
          reused: false,
        };
      }
      const slug = draftSlug(metadata.title);
      await c.query(
        `INSERT INTO app.documents(id,slug,title,summary,category_id,owner_id,owner_label,classification,labels)
    VALUES($1,$2,$3,$4,$5,app.actor_id(),$6,$8,$7)`,
        [
          claim.documentId,
          slug,
          metadata.title,
          metadata.summary,
          metadata.categoryId,
          owner.rows[0].name,
          metadata.labels,
          metadata.classification,
        ],
      );
      await c.query(
        `INSERT INTO app.document_versions(id,document_id,label,review_state,markdown_key,markdown_sha256,byte_size,source_format)
    VALUES($1,$2,'0.1','draft',$3,$4,$5,$6)`,
        [
          claim.versionId,
          claim.documentId,
          artifacts.markdown.key,
          converted.sha256,
          artifacts.markdown.size,
          file.format,
        ],
      );
      await c.query(
        `INSERT INTO app.version_sources(version_id,original_name,original_key,original_sha256,original_bytes,source_format,
    provenance_key,provenance_sha256,metadata_snapshot,scanner_version,signature_version,signature_date,scanned_at,scan_verdict,pipeline_revision,processing_state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,'clean',$14,'preview_ready')`,
        [
          claim.versionId,
          file.name,
          artifacts.original.key,
          file.sha256,
          artifacts.original.size,
          file.format,
          artifacts.provenance.key,
          artifacts.provenance.sha256,
          JSON.stringify(snapshot),
          evidence.version,
          evidence.signatureVersion,
          evidence.signatureDate,
          evidence.scannedAt,
          converted.pipeline ?? 'text-v1',
        ],
      );
      await attach();
      await c.query(
        "UPDATE app.upload_requests SET state='complete',error_code=NULL,updated_at=now() WHERE owner_id=app.actor_id() AND request_id=$1 AND lease_token=$2",
        [claim.requestId, claim.leaseToken],
      );
      await c.query(
        "INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.uploaded',$1,$2)",
        [claim.documentId, claim.requestId],
      );
      return { documentId: claim.documentId, versionId: claim.versionId, slug, reused: false };
    });
  }
  async fail(actor: Actor, claim: UploadClaim, code: string): Promise<void> {
    await withActor(actor.id, async ({ client: c }) => {
      const updated = await c.query(
        "UPDATE app.upload_requests SET state='failed',error_code=$1,updated_at=now() WHERE owner_id=app.actor_id() AND request_id=$2 AND lease_token=$3 AND state='processing' RETURNING request_id",
        [code.slice(0, 64), claim.requestId, claim.leaseToken],
      );
      if (updated.rowCount)
        await c.query(
          "INSERT INTO app.audit_events(actor_id,action,request_id) SELECT app.actor_id(),'upload.rejected',$1 WHERE app.actor_active() AND app.actor_role()<>'viewer'",
          [claim.requestId],
        );
    });
  }
}
export type UploadCategory = {
  id: string;
  name: string;
  allowed: boolean;
  minimumClassification: string;
};
export async function uploadCategories(actorId: string): Promise<UploadCategory[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      allowed: boolean;
      minimum_classification: string;
    }>(
      'SELECT id,name,app.category_floor(id) AS minimum_classification,app.can_upload_to(id) AS allowed FROM app.categories ORDER BY position,name',
    );
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      allowed: c.allowed,
      minimumClassification: c.minimum_classification,
    }));
  });
}
export type SourceMetadata = {
  name: string;
  format: string;
  bytes: number;
  hash: string;
  scannerVersion: string;
  scannedAt: string;
};
export async function readSourceMetadata(
  actorId: string,
  versionId: string,
): Promise<SourceMetadata | null> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      original_name: string;
      source_format: string;
      original_bytes: number;
      original_sha256: string;
      scanner_version: string;
      scanned_at: Date;
    }>(
      `SELECT original_name,source_format,original_bytes,original_sha256,scanner_version,scanned_at FROM app.version_sources WHERE version_id=$1`,
      [versionId],
    );
    const r = rows[0];
    return r
      ? {
          name: r.original_name,
          format: r.source_format,
          bytes: r.original_bytes,
          hash: r.original_sha256,
          scannerVersion: r.scanner_version,
          scannedAt: r.scanned_at.toISOString(),
        }
      : null;
  });
}
export async function readUploadArtifact(
  actorId: string,
  versionId: string,
  kind: 'original' | 'provenance',
): Promise<{ key: string; hash: string; format: string } | null> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      original_key: string;
      original_sha256: string;
      provenance_key: string;
      provenance_sha256: string;
      source_format: string;
      document_id: string;
    }>(
      `SELECT s.original_key,s.original_sha256,s.provenance_key,s.provenance_sha256,s.source_format,v.document_id FROM app.version_sources s JOIN app.document_versions v ON v.id=s.version_id WHERE s.version_id=$1`,
      [versionId],
    );
    const r = rows[0];
    if (!r) return null;
    await client.query(
      "INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.download',$1,$2)",
      [r.document_id, randomUUID()],
    );
    return {
      key: kind === 'original' ? r.original_key : r.provenance_key,
      hash: kind === 'original' ? r.original_sha256 : r.provenance_sha256,
      format: kind === 'original' ? r.source_format : 'JSON',
    };
  });
}

export interface StoredFile {
  key: string;
  sha256: string;
  size: number;
}
export interface BlobStore {
  putImmutable(key: string, bytes: Uint8Array): Promise<StoredFile>;
  read(key: string, expectedHash?: string): Promise<Uint8Array>;
}
export interface Identity {
  internalUserId: string;
  issuer: string;
  subject: string;
}
export interface EmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(
    texts: readonly string[],
    kind: 'query' | 'passage',
    signal?: AbortSignal,
  ): Promise<number[][]>;
}
export interface SourceReference {
  documentId: string;
  versionId: string;
  heading: string;
  locator: string;
}
export interface GroundedAnswer {
  text: string;
  sources: SourceReference[];
}
export interface GenerationProvider {
  generate(
    input: { question: string; context: readonly { text: string; source: SourceReference }[] },
    signal?: AbortSignal,
  ): Promise<GroundedAnswer>;
}
// Ports only. No placeholder provider may claim successful inference or processing.

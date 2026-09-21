// Types for the plain-JS shim (it runs in a node:22-alpine container without a build step).
export function stripQuestionTail(text: string): string;
export function isGeneratedSummary(text: string): boolean;
export function toTeiBody(
  query: string,
  documents: readonly string[],
): { query: string; texts: string[]; raw_scores: false; truncate: true };
export function toWeknoraResults(
  scored: unknown,
  documents: readonly string[],
): Array<{ index: number; relevance_score: number; document: { text: string } }> | null;

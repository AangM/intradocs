// Line diff between two immutable versions of one document. Pure and bounded: no I/O,
// and no input can make it allocate without limit. Used to show what actually changed
// between versions, so a reviewer compares text rather than trusting a version label.

export type DiffOp = 'same' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number on the left, null when the line only exists on the right. */
  left: number | null;
  right: number | null;
  text: string;
}

export interface DiffHunk {
  leftStart: number;
  rightStart: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the changed region was too large to align line by line. */
  truncated: boolean;
  identical: boolean;
}

export interface DiffOptions {
  /** Unchanged lines kept around each change, for context. */
  context?: number;
  /**
   * Largest changed region the aligner will process. The cost of aligning is the product
   * of both sides, so this is a real memory bound, not a formality: past it the result is
   * reported as truncated instead of the process growing without limit.
   */
  maxAlign?: number;
  /** Longest single line kept verbatim; longer lines are clamped for display. */
  maxLineChars?: number;
}

const DEFAULTS = { context: 3, maxAlign: 1500, maxLineChars: 500 } as const;

function splitLines(text: string): string[] {
  // Normalise line endings so a CRLF/LF difference alone never shows as a change.
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Longest common subsequence over the region that actually differs.
 *
 * Common prefix and suffix are stripped first. That is not just an optimisation: for a
 * typical revision it reduces the aligned region to the edited part, which is what keeps
 * the quadratic step inside the bound for real documents.
 */
export function diffLines(
  leftText: string,
  rightText: string,
  options: DiffOptions = {},
): DiffResult {
  const context = options.context ?? DEFAULTS.context;
  const maxAlign = options.maxAlign ?? DEFAULTS.maxAlign;
  const maxLineChars = options.maxLineChars ?? DEFAULTS.maxLineChars;
  const left = splitLines(leftText);
  const right = splitLines(rightText);

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix += 1;

  const leftMid = left.slice(prefix, left.length - suffix);
  const rightMid = right.slice(prefix, right.length - suffix);
  if (leftMid.length === 0 && rightMid.length === 0)
    return { hunks: [], added: 0, removed: 0, truncated: false, identical: true };

  const truncated = leftMid.length * rightMid.length > maxAlign * maxAlign;
  const clamp = (s: string) => (s.length > maxLineChars ? `${s.slice(0, maxLineChars)}…` : s);

  const all: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1)
    all.push({ op: 'same', left: i + 1, right: i + 1, text: clamp(left[i]!) });

  if (truncated) {
    // Report the shape of the change rather than a wrong alignment.
    for (let i = 0; i < leftMid.length; i += 1)
      all.push({ op: 'remove', left: prefix + i + 1, right: null, text: clamp(leftMid[i]!) });
    for (let i = 0; i < rightMid.length; i += 1)
      all.push({ op: 'add', left: null, right: prefix + i + 1, text: clamp(rightMid[i]!) });
  } else {
    const n = leftMid.length;
    const m = rightMid.length;
    // table[i][j] = LCS length of leftMid[i..] and rightMid[j..]
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        table[i]![j] =
          leftMid[i] === rightMid[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (leftMid[i] === rightMid[j]) {
        all.push({
          op: 'same',
          left: prefix + i + 1,
          right: prefix + j + 1,
          text: clamp(leftMid[i]!),
        });
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        all.push({ op: 'remove', left: prefix + i + 1, right: null, text: clamp(leftMid[i]!) });
        i += 1;
      } else {
        all.push({ op: 'add', left: null, right: prefix + j + 1, text: clamp(rightMid[j]!) });
        j += 1;
      }
    }
    while (i < n) {
      all.push({ op: 'remove', left: prefix + i + 1, right: null, text: clamp(leftMid[i]!) });
      i += 1;
    }
    while (j < m) {
      all.push({ op: 'add', left: null, right: prefix + j + 1, text: clamp(rightMid[j]!) });
      j += 1;
    }
  }

  const tailLeftStart = left.length - suffix;
  const tailRightStart = right.length - suffix;
  for (let k = 0; k < suffix; k += 1)
    all.push({
      op: 'same',
      left: tailLeftStart + k + 1,
      right: tailRightStart + k + 1,
      text: clamp(left[tailLeftStart + k]!),
    });

  const added = all.filter((l) => l.op === 'add').length;
  const removed = all.filter((l) => l.op === 'remove').length;
  return {
    hunks: toHunks(all, context),
    added,
    removed,
    truncated,
    identical: added === 0 && removed === 0,
  };
}

/** Groups changes into hunks, keeping `context` unchanged lines around each run. */
function toHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.op === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1)
      keep[k] = true;
  }
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i]) {
      current.push(lines[i]!);
      continue;
    }
    if (current.length) {
      hunks.push(makeHunk(current));
      current = [];
    }
  }
  if (current.length) hunks.push(makeHunk(current));
  return hunks;
}

function makeHunk(lines: DiffLine[]): DiffHunk {
  return {
    leftStart: lines.find((l) => l.left !== null)?.left ?? 0,
    rightStart: lines.find((l) => l.right !== null)?.right ?? 0,
    lines,
  };
}

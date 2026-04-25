// Shell out to `amp threads list` and parse the column-formatted output.
// The Amp SDK doesn't expose a list method, and the CLI has no JSON output
// option, so we parse the table by column widths derived from the separator
// row of ── characters.
import { spawn } from 'node:child_process';

export interface AmpThreadListEntry {
  threadId: string;
  title: string;
  lastUpdated: string;
  visibility: string;
  messages: number;
}

export async function listAmpThreads(includeArchived = false): Promise<AmpThreadListEntry[]> {
  const args = ['threads', 'list', '--no-color'];
  if (includeArchived) args.push('--include-archived');
  const child = spawn('amp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
  child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));
  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    throw new Error(`amp threads list failed (${exitCode}): ${stderr.trim()}`);
  }
  return parseAmpThreadList(Buffer.concat(stdoutChunks).toString('utf8'));
}

export function parseAmpThreadList(output: string): AmpThreadListEntry[] {
  const lines = output.split('\n');
  // Find the separator line of ── runs; columns are the runs separated by spaces.
  const sepIdx = lines.findIndex((l) => /^[\u2500]+(\s+[\u2500]+)+\s*$/.test(l));
  if (sepIdx < 1) return [];
  const sep = lines[sepIdx];
  const ranges = columnRangesFromSeparator(sep);
  if (ranges.length < 5) return [];
  const out: AmpThreadListEntry[] = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = ranges.map(([s, e]) => line.slice(s, e).trim());
    const [title, lastUpdated, visibility, messages, threadId] = cols;
    if (!/^T-[0-9a-f-]+$/i.test(threadId)) continue;
    out.push({
      threadId,
      title,
      lastUpdated,
      visibility,
      messages: Number.parseInt(messages, 10) || 0,
    });
  }
  return out;
}

function columnRangesFromSeparator(sep: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < sep.length) {
    if (sep[i] === '\u2500') {
      const start = i;
      while (i < sep.length && sep[i] === '\u2500') i++;
      ranges.push([start, i]);
    } else {
      i++;
    }
  }
  // Extend the last column to end-of-line to capture trailing chars.
  if (ranges.length > 0) ranges[ranges.length - 1][1] = Number.MAX_SAFE_INTEGER;
  return ranges;
}

/**
 * Convert relative timestamps like "9s ago", "5m ago", "1h ago", "2d ago"
 * into ISO 8601 strings relative to `now`. Returns undefined if unparseable.
 */
export function relativeToIso(rel: string, now: Date = new Date()): string | undefined {
  const m = rel.trim().match(/^(\d+)\s*([smhdw])\s*ago$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const factor =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : unit === 'd'
            ? 86_400_000
            : unit === 'w'
              ? 604_800_000
              : 0;
  if (!factor) return undefined;
  return new Date(now.getTime() - n * factor).toISOString();
}

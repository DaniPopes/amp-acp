// Shell out to `amp threads list --json` and parse the JSON output.
// The Amp SDK doesn't expose a list method, so we shell out to the CLI.
import { spawn } from 'node:child_process';

export interface AmpThreadListEntry {
  threadId: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
}

interface RawAmpThread {
  id: string;
  title: string | null;
  updated: string;
  messageCount: number;
}

export async function listAmpThreads(includeArchived = false): Promise<AmpThreadListEntry[]> {
  const args = ['threads', 'list', '--json'];
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
  const trimmed = output.trim();
  if (!trimmed) return [];
  const raw = JSON.parse(trimmed) as RawAmpThread[];
  return raw.map((r) => ({
    threadId: r.id,
    title: r.title,
    updatedAt: r.updated,
    messageCount: r.messageCount,
  }));
}

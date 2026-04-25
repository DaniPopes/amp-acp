// Create a new amp thread that forks/handsoff from an existing one.
//
// Amp has no native "copy thread" primitive that ACP's forkSession would map
// to cleanly. The closest CLI command is `amp threads handoff`, which:
//   - creates a new thread,
//   - prepends a synthesized "context" user message summarizing the source,
//   - appends our `--goal` text as the tail of that user message,
//   - DOES NOT execute the prompt (with --print).
//
// So we use a benign placeholder goal and let the user's first real prompt
// in the new ACP session continue against the new thread normally. The user
// will see a one-off "context" turn at the top of the forked thread; that's
// the cost of not having a real fork primitive.
import { spawn } from 'node:child_process';

const HANDOFF_GOAL = '(thread forked, awaiting next prompt)';

export async function forkAmpThread(sourceThreadId: string): Promise<string> {
  const child = spawn('amp', ['threads', 'handoff', sourceThreadId, '--print'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(HANDOFF_GOAL);
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
    throw new Error(`amp threads handoff failed (${exitCode}): ${stderr.trim()}`);
  }
  const out = Buffer.concat(stdoutChunks).toString('utf8').trim();
  // amp prints the new thread id, possibly followed by other lines.
  const match = out.match(/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/im);
  if (!match) {
    throw new Error(`amp threads handoff: no thread id in output: ${out}`);
  }
  return match[0];
}

// Fetch a thread's display cost via `amp threads usage <id>`.
//
// The CLI prints something like:
//   $13.08
//   Details: https://ampcode.com/threads/T-.../usage
//
// We parse out the dollar amount.
import { spawn } from 'node:child_process';

export async function fetchThreadCost(threadId: string): Promise<string> {
  const child = spawn('amp', ['threads', 'usage', threadId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    throw new Error(`amp threads usage failed (${exitCode}): ${stderr.trim()}`);
  }
  const out = Buffer.concat(stdoutChunks).toString('utf8');
  const match = out.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    throw new Error(`amp threads usage: no dollar amount in output: ${out.trim()}`);
  }
  return `$${match[1]}`;
}

// Estimate the context window for a model name. amp's primary models
// (smart/deep/rush) sit on Claude Sonnet/Opus at 200K; the `large` mode uses
// extended-context models (1M). We pattern-match conservatively and fall
// back to 200K when unknown.
export function contextWindowForModel(model: string | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('1m') || m.includes('large')) return 1_000_000;
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  return 200_000;
}

export function totalContextTokens(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

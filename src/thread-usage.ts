// Fetch a thread's display cost via `amp threads usage <id>`.
//
// The CLI prints something like:
//   $13.08
//   Details: https://ampcode.com/threads/T-.../usage
//
// We parse out the dollar amount.
import { spawn } from 'node:child_process';
import { exportThread } from './export-thread.js';

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

// Per-turn token usage as exposed via the live amp-sdk stream. Used as a
// fast-path when we already have it in memory; otherwise we go to the
// thread export (see fetchContextUsage) which is the authoritative source.
export interface LiveUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

export interface ContextUsage {
  totalInputTokens: number;
  maxInputTokens: number;
  model?: string;
}

// Sum the input-side tokens that count toward the model's context window.
function liveTotal(u: LiveUsage): number {
  return (
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  );
}

// Estimate the context window for a model name. Used only as a fallback
// when the export's `maxInputTokens` isn't available (e.g. fresh thread
// with only live SDK usage so far). Pattern-matches conservatively.
function contextWindowForModel(model: string | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('1m') || m.includes('large')) return 1_000_000;
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  return 200_000;
}

// Pull the most recent assistant `usage` block out of `amp threads export`.
// The export records authoritative per-turn usage with totalInputTokens and
// maxInputTokens, which is what we want for the context-% display. Returns
// null if export fails or no assistant turn with usage exists yet.
export async function fetchContextUsage(threadId: string): Promise<ContextUsage | null> {
  let thread: { messages: unknown[] };
  try {
    thread = (await exportThread(threadId)) as unknown as { messages: unknown[] };
  } catch {
    return null;
  }
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i] as { role?: string; usage?: Record<string, unknown> } | undefined;
    if (m?.role !== 'assistant' || !m.usage) continue;
    const u = m.usage;
    const totalInputTokens = Number(u.totalInputTokens ?? 0);
    const maxInputTokens = Number(u.maxInputTokens ?? 0);
    if (!maxInputTokens || !totalInputTokens) continue;
    return {
      totalInputTokens,
      maxInputTokens,
      model: typeof u.model === 'string' ? u.model : undefined,
    };
  }
  return null;
}

// Convert a live SDK usage record into the same {used, max} shape we use
// for the export-derived percentage.
export function liveUsageToContext(u: LiveUsage, model: string | undefined): ContextUsage {
  return {
    totalInputTokens: liveTotal(u),
    maxInputTokens: contextWindowForModel(model),
    model,
  };
}

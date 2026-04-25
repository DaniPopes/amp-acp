// Fetch a thread's structured history via `amp threads export <id>` and
// convert it into ACP session/update notifications.
//
// The Amp SDK only exposes `threads.markdown(...)` (rendered text). Shelling
// out to `amp threads export` gives us the full JSON payload — including
// thinking, tool_use, and tool_result blocks — so loadSession can replay a
// faithful structured history instead of just user/assistant text.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { toAcpNotifications, createAcpConversionState, type AcpConversionState } from './to-acp.js';

interface ExportedThreadMessage {
  role: 'user' | 'assistant';
  content: ExportedContent[];
  messageId?: number;
  agentMode?: string;
}

type ExportedContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseID: string; run: { result: unknown; status: string } };

interface ExportedThread {
  id: string;
  messages: ExportedThreadMessage[];
}

export async function exportThread(threadId: string): Promise<ExportedThread> {
  // amp truncates output at ~64KB when stdout is a pipe (Bun runtime quirk).
  // Workaround: write directly to a temp file fd and read it back.
  const tmpFile = path.join(
    os.tmpdir(),
    `amp-export-${threadId}-${process.pid}-${Date.now()}.json`,
  );
  const fd = fs.openSync(tmpFile, 'w');
  try {
    const child = spawn('amp', ['threads', 'export', threadId], {
      stdio: ['ignore', fd, 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b));
    const exitCode: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? 1));
    });
    fs.closeSync(fd);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (exitCode !== 0) {
      throw new Error(`amp threads export ${threadId} failed (${exitCode}): ${stderr.trim()}`);
    }
    return JSON.parse(fs.readFileSync(tmpFile, 'utf8')) as ExportedThread;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/** Convert exported thread JSON into ACP notifications, reusing toAcpNotifications. */
export function exportedThreadToNotifications(
  thread: ExportedThread,
  state: AcpConversionState = createAcpConversionState(),
): SessionNotification[] {
  const out: SessionNotification[] = [];
  for (const msg of thread.messages) {
    // Echo the original user prompt(s) so the client renders them in history.
    if (msg.role === 'user') {
      for (const c of msg.content) {
        if (c.type === 'text') {
          out.push({
            sessionId: thread.id,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: c.text },
            },
          });
        }
      }
    }

    // Convert to live-stream-shaped message and reuse the existing converter so
    // tool_use → tool_call, tool_result → tool_call_update, thinking →
    // agent_thought_chunk all stay in one place.
    const liveContent = msg.content.map(toLiveStreamContent).filter((c) => c !== null);
    const liveMessage = {
      type: msg.role,
      message: { content: liveContent as never },
    };
    out.push(...toAcpNotifications(liveMessage, thread.id, state));
  }
  return out;
}

function toLiveStreamContent(c: ExportedContent): unknown {
  switch (c.type) {
    case 'text':
    case 'thinking':
      return c;
    case 'tool_use':
      return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result': {
      const result = c.run?.result;
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return {
        type: 'tool_result',
        tool_use_id: c.toolUseID,
        content: text,
        is_error: c.run?.status !== 'done',
      };
    }
  }
}

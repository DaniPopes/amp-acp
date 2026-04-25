import path from 'node:path';
import type {
  SessionNotification,
  ContentBlock,
  ToolCallContent,
  ToolKind,
  ToolCallLocation,
  PlanEntry,
} from '@agentclientprotocol/sdk';

interface AmpContentText {
  type: 'text';
  text: string;
}

interface AmpContentImage {
  type: 'image';
  source?: {
    type: 'base64' | 'url';
    data?: string;
    media_type?: string;
    url?: string;
  };
}

interface AmpContentThinking {
  type: 'thinking';
  thinking: string;
}

interface AmpContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AmpContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AmpContentText[];
  is_error: boolean;
}

type AmpContentBlock =
  | AmpContentText
  | AmpContentImage
  | AmpContentThinking
  | AmpContentToolUse
  | AmpContentToolResult;

interface AmpMessage {
  type: string;
  message?: {
    content: string | AmpContentBlock[];
  };
  session_id?: string;
}

export interface AcpConversionState {
  cwd?: string;
  /** Whether the client supports the Zed/codex `_meta.terminal_output` extension for live terminal rendering of Bash. */
  supportsTerminalOutput?: boolean;
  /** tool_use_id -> tool name, used to render results in a tool-aware way. */
  toolNamesById: Map<string, string>;
}

export function createAcpConversionState(
  cwd?: string,
  supportsTerminalOutput = false,
): AcpConversionState {
  return { cwd, supportsTerminalOutput, toolNamesById: new Map() };
}

const MAX_TITLE_LENGTH = 256;

export function toAcpNotifications(
  message: AmpMessage,
  sessionId: string,
  state: AcpConversionState = createAcpConversionState(),
): SessionNotification[] {
  const role: 'assistant' | 'user' = message.type === 'assistant' ? 'assistant' : 'user';
  const content = message.message?.content;
  // For user messages we only care about tool_result blocks. Text/image blocks in
  // Amp's user messages are echoes of the prompt the client already displayed.
  if (role === 'user' && typeof content === 'string') return [];
  if (typeof content === 'string') {
    return [
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: content } as ContentBlock,
        },
      },
    ];
  }
  const output: SessionNotification[] = [];
  if (!Array.isArray(content)) return output;
  for (const chunk of content) {
    let update: SessionNotification['update'] | null = null;
    if (role === 'user' && chunk.type !== 'tool_result') continue;
    switch (chunk.type) {
      case 'text':
        update = {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk.text } as ContentBlock,
        };
        break;
      case 'image':
        update = {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            data: chunk.source?.type === 'base64' ? (chunk.source.data ?? '') : '',
            mimeType: chunk.source?.type === 'base64' ? (chunk.source.media_type ?? '') : '',
            uri: chunk.source?.type === 'url' ? chunk.source.url : undefined,
          } as ContentBlock,
        };
        break;
      case 'thinking':
        update = {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.thinking } as ContentBlock,
        };
        break;
      case 'tool_use': {
        const input = (chunk.input ?? {}) as Record<string, unknown>;
        state.toolNamesById.set(chunk.id, chunk.name);

        // todo_write becomes a `plan` update, not a tool_call.
        if (chunk.name === 'todo_write') {
          const entries = planEntriesFromTodos(input.todos);
          if (entries.length > 0) {
            update = { sessionUpdate: 'plan', entries };
            break;
          }
        }

        // Bash with terminal_output capability: render as a live terminal widget.
        if (chunk.name === 'Bash' && state.supportsTerminalOutput) {
          const terminalId = chunk.id;
          const bashCwd = firstString(input, ['cwd']);
          // Only include cwd in terminal_info when it differs from the project
          // root; otherwise Zed renders it as the widget title (redundant noise).
          const includeCwd =
            bashCwd && state.cwd && path.resolve(state.cwd, bashCwd) !== path.resolve(state.cwd);
          update = {
            toolCallId: chunk.id,
            sessionUpdate: 'tool_call' as const,
            rawInput: safeJson(chunk.input),
            status: 'pending' as const,
            title: sanitizeTitle(titleForTool(chunk.name, input, state.cwd)),
            kind: 'execute' as const,
            content: [{ type: 'terminal' as const, terminalId }],
            _meta: {
              terminal_info: includeCwd
                ? { terminal_id: terminalId, cwd: bashCwd }
                : { terminal_id: terminalId },
            },
          } as unknown as SessionNotification['update'];
          break;
        }

        update = {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call' as const,
          rawInput: safeJson(chunk.input),
          status: 'pending' as const,
          title: sanitizeTitle(titleForTool(chunk.name, input, state.cwd)),
          kind: kindForTool(chunk.name),
          content: contentForToolUse(chunk.name, input, state.cwd),
          locations: locationsForTool(chunk.name, input),
        };
        break;
      }
      case 'tool_result': {
        const toolName = state.toolNamesById.get(chunk.tool_use_id);

        // todo_write results carry no useful info for the UI; the plan was already shown.
        if (toolName === 'todo_write') break;

        // Bash with terminal_output capability: stream output via _meta then close with exit code.
        if (toolName === 'Bash' && state.supportsTerminalOutput) {
          const terminalId = chunk.tool_use_id;
          const { data, exitCode } = parseBashResult(chunk.content, chunk.is_error);
          const failed = chunk.is_error || exitCode !== 0;
          if (data) {
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.tool_use_id,
                sessionUpdate: 'tool_call_update' as const,
                _meta: { terminal_output: { terminal_id: terminalId, data } },
              } as unknown as SessionNotification['update'],
            });
          }
          output.push({
            sessionId,
            update: {
              toolCallId: chunk.tool_use_id,
              sessionUpdate: 'tool_call_update' as const,
              status: failed ? ('failed' as const) : ('completed' as const),
              content: [{ type: 'terminal' as const, terminalId }],
              _meta: {
                terminal_exit: { terminal_id: terminalId, exit_code: exitCode, signal: null },
              },
            } as unknown as SessionNotification['update'],
          });
          break;
        }

        const resultContent = contentForToolResult(toolName, chunk.content, chunk.is_error);
        // For Bash without terminal capability, also honor a non-zero exitCode as failure.
        let failed = chunk.is_error;
        if (toolName === 'Bash' && !failed) {
          const { exitCode } = parseBashResult(chunk.content, false);
          if (exitCode !== 0) failed = true;
        }
        const u: Record<string, unknown> = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: 'tool_call_update' as const,
          status: failed ? ('failed' as const) : ('completed' as const),
        };
        // Only set `content` when we actually have something to show; otherwise we'd
        // clobber whatever was attached at tool_call time (e.g. the diff).
        if (resultContent !== undefined) u.content = resultContent;
        update = u as SessionNotification['update'];
        break;
      }
      default:
        break;
    }
    if (update) output.push({ sessionId, update });
  }
  return output;
}

function contentForToolResult(
  toolName: string | undefined,
  content: string | AmpContentText[],
  isError: boolean,
): ToolCallContent[] | undefined {
  // For edit_file/create_file/undo_edit, the diff is already attached to the tool_call.
  // Returning `undefined` leaves it untouched (returning `[]` would clobber it).
  if (
    !isError &&
    (toolName === 'edit_file' ||
      toolName === 'create_file' ||
      toolName === 'undo_edit' ||
      toolName === 'format_file')
  ) {
    return undefined;
  }
  // Read benefits from adaptive fences so file content (which itself may contain ```) renders cleanly.
  if (!isError && toolName === 'Read') {
    const text = stringifyContent(content);
    return text
      ? [{ type: 'content', content: { type: 'text', text: markdownEscape(text) } }]
      : undefined;
  }
  // Bash output reads better in a console fence.
  if (!isError && toolName === 'Bash') {
    const { data } = parseBashResult(content, false);
    return data
      ? [
          {
            type: 'content',
            content: { type: 'text', text: '```console\n' + data.trimEnd() + '\n```' },
          },
        ]
      : undefined;
  }
  return toAcpContentArray(content, isError);
}

/**
 * Amp's Bash tool serializes its result as a JSON string like
 * `{"output":"...","exitCode":0}`. Extract the human-readable output and exit code,
 * with sensible fallbacks if the format ever changes or Amp emits a plain string.
 */
export function parseBashResult(
  content: string | AmpContentText[],
  isError: boolean,
): { data: string; exitCode: number } {
  const raw = stringifyContent(content);
  const fallbackExit = isError ? 1 : 0;
  if (!raw) return { data: '', exitCode: fallbackExit };
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const out =
        (typeof parsed.output === 'string' && parsed.output) ||
        [parsed.stdout, parsed.stderr]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join('\n') ||
        '';
      const code =
        typeof parsed.exitCode === 'number'
          ? parsed.exitCode
          : typeof parsed.exit_code === 'number'
            ? parsed.exit_code
            : typeof parsed.return_code === 'number'
              ? parsed.return_code
              : fallbackExit;
      return { data: out, exitCode: code };
    } catch {
      // not JSON; fall through.
    }
  }
  return { data: raw, exitCode: fallbackExit };
}

function stringifyContent(content: string | AmpContentText[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
  return '';
}

function toAcpContentArray(content: string | AmpContentText[], isError = false): ToolCallContent[] {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((c) => ({
      type: 'content' as const,
      content: { type: 'text' as const, text: isError ? wrapCode(c.text) : c.text },
    }));
  }
  if (typeof content === 'string' && content.length > 0) {
    return [
      {
        type: 'content' as const,
        content: { type: 'text' as const, text: isError ? wrapCode(content) : content },
      },
    ];
  }
  return [];
}

function wrapCode(t: string): string {
  return '```\n' + t + '\n```';
}

/** Widen a fence as needed to safely embed arbitrary text. */
export function markdownEscape(text: string): string {
  let fence = '```';
  for (const m of text.matchAll(/^`{3,}/gm)) {
    while (m[0].length >= fence.length) fence += '`';
  }
  return fence + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence;
}

export function sanitizeTitle(text: string): string {
  const sanitized = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) return sanitized;
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + '…';
}

function safeJson(x: unknown): { [k: string]: unknown } | undefined {
  try {
    return JSON.parse(JSON.stringify(x)) as { [k: string]: unknown };
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(input[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function toAbsolutePath(filePath: string, cwd?: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!cwd) return filePath;
  try {
    return path.resolve(cwd, filePath);
  } catch {
    return filePath;
  }
}

export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!filePath || !cwd) return filePath;
  try {
    const resolvedCwd = path.resolve(cwd);
    const resolvedFile = path.resolve(cwd, filePath);
    if (resolvedFile === resolvedCwd) return '.';
    if (resolvedFile.startsWith(resolvedCwd + path.sep)) {
      return path.relative(resolvedCwd, resolvedFile);
    }
    return filePath;
  } catch {
    return filePath;
  }
}

export function kindForTool(name: string): ToolKind {
  switch (name) {
    case 'Bash':
      return 'execute';
    case 'Read':
    case 'list_directory':
    case 'librarian':
    case 'read_thread':
      return 'read';
    case 'Grep':
    case 'glob':
    case 'finder':
    case 'find_thread':
      return 'search';
    case 'edit_file':
    case 'create_file':
    case 'undo_edit':
    case 'format_file':
      return 'edit';
    case 'web_search':
    case 'read_web_page':
      return 'fetch';
    case 'Task':
    case 'oracle':
    case 'mermaid':
    case 'painter':
    case 'skill':
    case 'task_list':
      return 'think';
    default:
      return 'other';
  }
}

export function titleForTool(name: string, input: Record<string, unknown>, cwd?: string): string {
  switch (name) {
    case 'Bash': {
      const cmd = firstString(input, ['cmd', 'command']);
      return cmd || 'Terminal';
    }
    case 'Read': {
      const p = firstString(input, ['path', 'file_path']);
      if (!p) return 'Read';
      const display = toDisplayPath(p, cwd);
      const range = input.read_range;
      if (Array.isArray(range)) {
        const start = num(range[0]);
        const end = num(range[1]);
        if (start !== undefined && end !== undefined) return `Read ${display} (${start} - ${end})`;
        if (start !== undefined) return `Read ${display} (from line ${start})`;
      }
      return `Read ${display}`;
    }
    case 'list_directory': {
      const p = firstString(input, ['path']);
      return p ? `List ${toDisplayPath(p, cwd)}` : 'List directory';
    }
    case 'edit_file': {
      const p = firstString(input, ['path']);
      return p ? `Edit ${toDisplayPath(p, cwd)}` : 'Edit';
    }
    case 'create_file': {
      const p = firstString(input, ['path']);
      return p ? `Create ${toDisplayPath(p, cwd)}` : 'Create';
    }
    case 'undo_edit': {
      const p = firstString(input, ['path']);
      return p ? `Undo edit ${toDisplayPath(p, cwd)}` : 'Undo edit';
    }
    case 'format_file': {
      const p = firstString(input, ['path']);
      return p ? `Format ${toDisplayPath(p, cwd)}` : 'Format';
    }
    case 'Grep': {
      const pattern = firstString(input, ['pattern', 'query']);
      const p = firstString(input, ['path']);
      const include = firstString(input, ['include']);
      let label = 'Grep';
      if (pattern) label += ` "${pattern}"`;
      if (include) label += ` --include="${include}"`;
      if (p) label += ` ${toDisplayPath(p, cwd)}`;
      return label;
    }
    case 'glob': {
      const pattern = firstString(input, ['filePattern', 'pattern']);
      const p = firstString(input, ['path']);
      let label = 'Find';
      if (p) label += ` \`${toDisplayPath(p, cwd)}\``;
      if (pattern) label += ` \`${pattern}\``;
      return label === 'Find' ? 'Find' : label;
    }
    case 'web_search': {
      const queries = input.search_queries;
      if (Array.isArray(queries) && queries.length > 0) {
        return `"${String(queries[0])}"${queries.length > 1 ? ` (+${queries.length - 1})` : ''}`;
      }
      const obj = firstString(input, ['objective']);
      return obj ? `Web search: ${obj}` : 'Web search';
    }
    case 'read_web_page': {
      const url = firstString(input, ['url']);
      return url ? `Fetch ${url}` : 'Fetch';
    }
    case 'Task': {
      const desc = firstString(input, ['description']);
      return desc ? `Task: ${desc}` : 'Task';
    }
    case 'todo_write':
      return 'Update TODOs';
    case 'todo_read':
      return 'Read TODOs';
    case 'oracle': {
      const task = firstString(input, ['task']);
      return task ? `Oracle: ${task}` : 'Oracle';
    }
    case 'mermaid':
      return 'Mermaid diagram';
    case 'painter': {
      const prompt = firstString(input, ['prompt']);
      return prompt ? `Paint: ${prompt}` : 'Paint';
    }
    case 'finder': {
      const q = firstString(input, ['query']);
      return q ? `Finder: ${q}` : 'Finder';
    }
    case 'librarian': {
      const q = firstString(input, ['query']);
      return q ? `Librarian: ${q}` : 'Librarian';
    }
    case 'read_thread': {
      const id = firstString(input, ['threadID']);
      return id ? `Read thread ${id}` : 'Read thread';
    }
    case 'find_thread': {
      const q = firstString(input, ['query']);
      return q ? `Find threads: ${q}` : 'Find threads';
    }
    case 'skill': {
      const n = firstString(input, ['name']);
      return n ? `Skill: ${n}` : 'Skill';
    }
    case 'task_list': {
      const action = firstString(input, ['action']);
      return action ? `Tasks: ${action}` : 'Task list';
    }
    default:
      return name || 'Tool';
  }
}

function contentForToolUse(
  name: string,
  input: Record<string, unknown>,
  cwd?: string,
): ToolCallContent[] {
  switch (name) {
    case 'edit_file': {
      const p = str(input.path);
      const oldStr = str(input.old_str);
      const newStr = str(input.new_str);
      if (p && oldStr !== undefined && newStr !== undefined) {
        return [{ type: 'diff', path: toAbsolutePath(p, cwd), oldText: oldStr, newText: newStr }];
      }
      return [];
    }
    case 'create_file': {
      const p = str(input.path);
      const newText = str(input.content);
      if (p && newText !== undefined) {
        return [{ type: 'diff', path: toAbsolutePath(p, cwd), oldText: null, newText }];
      }
      return [];
    }
    case 'mermaid': {
      const diagram = str(input.diagram);
      if (diagram)
        return [
          { type: 'content', content: { type: 'text', text: '```mermaid\n' + diagram + '\n```' } },
        ];
      return [];
    }
    default:
      return [];
  }
}

function locationsForTool(
  name: string,
  input: Record<string, unknown>,
): ToolCallLocation[] | undefined {
  switch (name) {
    case 'Read': {
      const p = firstString(input, ['path', 'file_path']);
      if (!p) return undefined;
      const range = input.read_range;
      const line = Array.isArray(range) ? num(range[0]) : undefined;
      return [line !== undefined ? { path: p, line } : { path: p }];
    }
    case 'edit_file':
    case 'create_file':
    case 'undo_edit':
    case 'format_file':
    case 'list_directory': {
      const p = firstString(input, ['path']);
      return p ? [{ path: p }] : undefined;
    }
    case 'Grep':
    case 'glob': {
      const p = firstString(input, ['path']);
      return p ? [{ path: p }] : undefined;
    }
    default:
      return undefined;
  }
}

interface AmpTodo {
  content?: string;
  text?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

function planEntriesFromTodos(todos: unknown): PlanEntry[] {
  if (!Array.isArray(todos)) return [];
  const out: PlanEntry[] = [];
  for (const t of todos as AmpTodo[]) {
    const content = t?.content ?? t?.text;
    if (typeof content !== 'string' || content.length === 0) continue;
    out.push({
      content,
      status: t?.status ?? 'pending',
      priority: t?.priority ?? 'medium',
    });
  }
  return out;
}

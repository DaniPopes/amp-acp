import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
  type SessionNotification,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type AuthMethod,
} from '@agentclientprotocol/sdk';
import { execute, threads, type StreamMessage } from '@sourcegraph/amp-sdk';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { toAcpNotifications, createAcpConversionState, type AcpConversionState } from './to-acp.js';
import { exportThread, exportedThreadToNotifications } from './export-thread.js';
import { forkAmpThread } from './fork-thread.js';
import { listAmpThreads, relativeToIso } from './list-threads.js';
import path from 'node:path';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: string;
  model: string;
  mcpConfig: AmpMcpConfig;
  cwd: string;
}

const AVAILABLE_MODES = [
  {
    id: 'default',
    name: 'Default',
    description: 'Prompts for permission on first use of each tool',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only analysis mode; do not modify files',
  },
  { id: 'bypass', name: 'Bypass', description: 'Skips all permission prompts' },
];

const AVAILABLE_MODELS = [
  { modelId: 'smart', name: 'Smart', description: 'Default balanced model' },
  { modelId: 'rush', name: 'Rush', description: 'Fastest, lowest quality' },
  { modelId: 'large', name: 'Large', description: 'Larger context, slower' },
  { modelId: 'deep', name: 'Deep', description: 'Highest reasoning, slowest' },
];

const PLAN_MODE_PREFIX =
  '[PLAN MODE ACTIVE: You are in read-only analysis mode. ' +
  'Analyze, research, and plan but do NOT write code or modify files. ' +
  'If the user asks you to implement something, explain your plan instead.]\n\n';

const COMMAND_TO_MODE: Record<string, string> = {
  plan: 'plan',
  code: 'default',
  yolo: 'bypass',
};

const COMMAND_TO_PROMPT_PREFIX: Record<string, string> = {
  oracle:
    'Use the Oracle tool to help with this task. Consult the Oracle for expert analysis, planning, or debugging:\n\n',
  librarian:
    'Use the Librarian tool to explore and understand code. Ask the Librarian to analyze repositories on GitHub:\n\n',
  task: 'Use the Task tool to spawn a subagent for this multi-step implementation. Provide detailed instructions:\n\n',
  parallel:
    'Spawn multiple Task subagents to work on these independent tasks in parallel. Each task should be self-contained:\n\n',
  web: 'Use web_search and read_web_page tools to find information about:\n\n',
};

const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;

const AVAILABLE_COMMANDS = [
  { name: 'init', description: 'Generate an AGENTS.md file for the project' },
  { name: 'plan', description: 'Switch to read-only analysis mode' },
  { name: 'code', description: 'Switch to default mode' },
  { name: 'yolo', description: 'Bypass all permission prompts' },
  {
    name: 'oracle',
    description: 'Consult the Oracle for planning, review, or debugging',
  },
  {
    name: 'librarian',
    description: 'Ask the Librarian to explore codebases on GitHub',
  },
  {
    name: 'task',
    description: 'Spawn a Task subagent for multi-step implementation',
  },
  { name: 'parallel', description: 'Run multiple subagents in parallel' },
  {
    name: 'web',
    description: 'Search the web for documentation or information',
  },
];

function buildConfigOptions(modeId: string, modelId: string): SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select',
      currentValue: modeId,
      options: AVAILABLE_MODES.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'Amp model to use',
      category: 'model',
      type: 'select',
      currentValue: modelId,
      options: AVAILABLE_MODELS.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description,
      })),
    },
  ];
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponseWithAgentInfo> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);

    // Only advertise terminal-auth methods to clients that signal support via
    // `_meta["terminal-auth"]`; other clients can't launch them and would just
    // see broken options. The API-key `setup` flow is the same shape (it also
    // needs a terminal), so it's gated identically.
    const supportsMetaTerminalAuth =
      (request.clientCapabilities as { _meta?: { 'terminal-auth'?: boolean } } | undefined)
        ?._meta?.['terminal-auth'] === true;

    const authMethods: AuthMethod[] = [];
    if (supportsMetaTerminalAuth) {
      authMethods.push(
        {
          id: 'amp-login',
          name: 'Amp Login (browser)',
          description: 'Sign in to Amp via your browser (recommended)',
          _meta: {
            'terminal-auth': {
              command: 'amp',
              args: ['login'],
              label: 'Amp Login',
            },
          },
        },
        {
          id: 'setup',
          name: 'Amp API Key Setup',
          description: 'Run interactive setup to configure your Amp API key',
          _meta: {
            'terminal-auth': {
              command: getTerminalAuthCommand(),
              args: ['--setup'],
              label: 'Amp API Key Setup',
            },
          },
        },
      );
    }

    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'amp-acp',
        title: 'Amp ACP Agent',
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          close: {},
          list: {},
          resume: {},
          fork: {},
        },
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods,
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);

    // Allocate a real Amp thread up-front so the ACP sessionId equals the Amp
    // thread id. This makes the session resumable via loadSession (which calls
    // `amp threads markdown <id>`); a synthetic S- id would be rejected.
    let sessionId: string;
    try {
      sessionId = await threads.new();
    } catch (e) {
      console.error('[acp] threads.new() failed, falling back to synthetic sessionId', e);
      sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    this.sessions.set(sessionId, {
      threadId: sessionId.startsWith('T-') ? sessionId : null,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      model: 'smart',
      mcpConfig,
      cwd: params.cwd || process.cwd(),
    });

    const result: NewSessionResponse = {
      sessionId,
      modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
      models: { currentModelId: 'smart', availableModels: AVAILABLE_MODELS },
      configOptions: buildConfigOptions('default', 'smart'),
    };

    setImmediate(() => this.sendAvailableCommandsUpdate(sessionId));

    return result;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: AVAILABLE_COMMANDS,
        },
      });
    } catch (e) {
      console.error('[acp] failed to send available_commands_update', e);
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Reject anything that isn't an Amp thread id up-front so Zed surfaces the
    // error at thread-open time instead of silently failing on the first
    // prompt (when we'd pass it as `continue:` to Amp).
    if (
      !/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.sessionId)
    ) {
      throw new RequestError(-32602, `Invalid thread ID: ${params.sessionId}. Expected T-{uuid}.`);
    }

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const cwd = params.cwd || process.cwd();

    // Try the structured export first (full tool_use/tool_result/thinking
    // history); fall back to markdown parsing if the CLI doesn't support
    // `threads export` or anything else goes wrong.
    let notifications: SessionNotification[];
    try {
      const thread = await exportThread(params.sessionId);
      notifications = exportedThreadToNotifications(thread, createAcpConversionState(cwd));
    } catch (e) {
      console.error('[acp] threads export failed, falling back to markdown:', e);
      const md = await threads.markdown({ threadId: params.sessionId });
      notifications = parseThreadMarkdown(md, params.sessionId);
    }

    this.sessions.set(params.sessionId, {
      threadId: params.sessionId,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      model: 'smart',
      mcpConfig,
      cwd,
    });

    for (const note of notifications) {
      await this.client.sessionUpdate(note);
    }

    setImmediate(() => this.sendAvailableCommandsUpdate(params.sessionId));

    return {
      modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
      models: { currentModelId: 'smart', availableModels: AVAILABLE_MODELS },
      configOptions: buildConfigOptions('default', 'smart'),
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    if (
      !/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.sessionId)
    ) {
      throw new RequestError(-32602, `Invalid thread ID: ${params.sessionId}. Expected T-{uuid}.`);
    }

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const cwd = params.cwd || process.cwd();

    let newThreadId: string;
    try {
      newThreadId = await forkAmpThread(params.sessionId);
    } catch (e) {
      throw new RequestError(-32603, `amp threads handoff failed: ${(e as Error).message}`);
    }

    this.sessions.set(newThreadId, {
      threadId: newThreadId,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      model: 'smart',
      mcpConfig,
      cwd,
    });

    // Replay the source thread's history to the client so the user sees the
    // prior conversation in the new session pane. The handoff already injected
    // a synthesized "context" turn into the new amp thread, so future prompts
    // on newThreadId will continue against that handoff context server-side.
    try {
      const thread = await exportThread(params.sessionId);
      const notifications = exportedThreadToNotifications(thread, createAcpConversionState(cwd));
      // Rewrite sessionId in each notification to point at the new session.
      for (const note of notifications) {
        await this.client.sessionUpdate({ ...note, sessionId: newThreadId });
      }
    } catch (e) {
      console.error('[acp] forkSession: failed to replay source history:', e);
    }

    setImmediate(() => this.sendAvailableCommandsUpdate(newThreadId));

    return {
      sessionId: newThreadId,
      modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
      models: { currentModelId: 'smart', availableModels: AVAILABLE_MODELS },
      configOptions: buildConfigOptions('default', 'smart'),
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (
      !/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.sessionId)
    ) {
      throw new RequestError(-32602, `Invalid thread ID: ${params.sessionId}. Expected T-{uuid}.`);
    }

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const cwd = params.cwd || process.cwd();

    this.sessions.set(params.sessionId, {
      threadId: params.sessionId,
      controller: null,
      cancelled: false,
      active: false,
      mode: 'default',
      model: 'smart',
      mcpConfig,
      cwd,
    });

    setImmediate(() => this.sendAvailableCommandsUpdate(params.sessionId));

    return {
      modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
      models: { currentModelId: 'smart', availableModels: AVAILABLE_MODELS },
      configOptions: buildConfigOptions('default', 'smart'),
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // The amp-login terminal-auth method runs `amp login`, which stores
    // credentials in ~/.config/amp (not in any env var our agent process
    // sees), so we can't verify it from here. Trust the flow: if amp itself
    // is authed, subprocess invocations will succeed; if not, the next
    // prompt will surface the auth failure. The setup flow does set our
    // local API key file (loaded into AMP_API_KEY at startup), which we can
    // verify directly.
    if (params.methodId === 'amp-login') {
      return {};
    }
    if (process.env.AMP_API_KEY) {
      return {};
    }
    throw RequestError.authRequired();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;

    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          textInput += chunk.text;
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          break;
        default:
          break;
      }
    }

    // Slash command handling: /init, mode commands (/plan, /code, /yolo),
    // and agent shortcuts (/oracle, /librarian, /task, /parallel, /web).
    const trimmed = textInput.trim();
    const cmdMatch = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      const [, cmdName, cmdArg] = cmdMatch;
      const argText = cmdArg?.trim() ?? '';

      if (cmdName === 'init') {
        textInput = INIT_PROMPT;
      } else if (COMMAND_TO_MODE[cmdName]) {
        const newMode = COMMAND_TO_MODE[cmdName];
        s.mode = newMode;
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: newMode,
          },
        });
        if (argText) {
          textInput = argText + '\n';
        } else {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Switched to ${newMode} mode.` },
            },
          });
          s.active = false;
          return { stopReason: 'end_turn' };
        }
      } else if (COMMAND_TO_PROMPT_PREFIX[cmdName]) {
        if (!argText) {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Usage: /${cmdName} <your request>`,
              },
            },
          });
          s.active = false;
          return { stopReason: 'end_turn' };
        }
        textInput = COMMAND_TO_PROMPT_PREFIX[cmdName] + argText + '\n';
      }
    }

    if (s.mode === 'plan') {
      textInput = PLAN_MODE_PREFIX + textInput;
    }

    const options: Record<string, unknown> = {
      cwd: s.cwd,
      env: { TERM: 'dumb' },
      mode: s.model,
    };

    if (s.mode === 'bypass') {
      options.dangerouslyAllowAll = true;
    }

    if (Object.keys(s.mcpConfig).length > 0) {
      options.mcpConfig = s.mcpConfig;
    }

    if (s.threadId) {
      options.continue = s.threadId;
    }

    const controller = new AbortController();
    s.controller = controller;

    const supportsTerminalOutput =
      (this.clientCapabilities as { _meta?: { terminal_output?: boolean } } | undefined)?._meta
        ?.terminal_output === true;
    const acpState: AcpConversionState = createAcpConversionState(s.cwd, supportsTerminalOutput);

    try {
      for await (const message of execute({
        prompt: textInput,
        options,
        signal: controller.signal,
      })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
        }

        if (message.type === 'assistant' || message.type === 'user') {
          for (const n of toAcpNotifications(message, params.sessionId, acpState)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          if (typeof message.error === 'string' && isAuthError(message.error)) {
            console.error('[amp] Auth error in result, requesting authentication:', message.error);
            throw RequestError.authRequired();
          }
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Error: ${message.error}` },
            },
          });
        }
      }

      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } catch (err) {
      if (
        s.cancelled ||
        (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')))
      ) {
        return { stopReason: 'cancelled' };
      }
      if (err instanceof Error && isAuthError(err.message)) {
        console.error('[amp] Auth error, requesting authentication:', err.message);
        throw RequestError.authRequired();
      }
      console.error('[amp] Execution error:', err);
      throw err;
    } finally {
      s.active = false;
      s.cancelled = false;
      s.controller = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    if (s.active && s.controller) {
      s.cancelled = true;
      s.controller.abort();
    }
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!AVAILABLE_MODELS.some((m) => m.modelId === params.modelId)) {
      throw new RequestError(-32602, `Unknown model: ${params.modelId}`);
    }
    s.model = params.modelId;
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!AVAILABLE_MODES.some((m) => m.id === params.modeId)) {
      throw new RequestError(-32602, `Unknown mode: ${params.modeId}`);
    }
    s.mode = params.modeId;
    // Notify the client so its mode indicator re-renders without waiting for
    // the next turn.
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
      });
    } catch (e) {
      console.error('[acp] failed to send current_mode_update', e);
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (typeof params.value !== 'string') {
      throw new RequestError(
        -32602,
        `Invalid value for config option ${params.configId}: expected string`,
      );
    }
    if (params.configId === 'mode') {
      if (!AVAILABLE_MODES.some((m) => m.id === params.value)) {
        throw new RequestError(-32602, `Unknown mode: ${params.value}`);
      }
      s.mode = params.value;
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: params.value },
        });
      } catch (e) {
        console.error('[acp] failed to send current_mode_update', e);
      }
    } else if (params.configId === 'model') {
      if (!AVAILABLE_MODELS.some((m) => m.modelId === params.value)) {
        throw new RequestError(-32602, `Unknown model: ${params.value}`);
      }
      s.model = params.value;
    } else {
      throw new RequestError(-32602, `Unknown config option: ${params.configId}`);
    }
    return { configOptions: buildConfigOptions(s.mode, s.model) };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // The Amp CLI doesn't expose pagination; ignore params.cursor.
    // params.cwd / additionalDirectories are also ignored because Amp doesn't
    // record per-thread cwd. We return all threads and let the client filter
    // (or just show them all).
    void params;
    const cwd = process.cwd();
    try {
      const entries = await listAmpThreads();
      return {
        sessions: entries.map((e) => ({
          sessionId: e.threadId,
          cwd,
          title: e.title || null,
          updatedAt: relativeToIso(e.lastUpdated) ?? null,
        })),
      };
    } catch (err) {
      console.error('[acp] listSessions failed:', err);
      return { sessions: [] };
    }
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return {};
    if (s.active && s.controller) {
      s.cancelled = true;
      s.controller.abort();
    }
    this.sessions.delete(params.sessionId);
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.client.readTextFile(params);
  }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.client.writeTextFile(params);
  }
}

/**
 * Parse the markdown returned by `amp threads markdown` into per-turn ACP
 * session notifications. The format is YAML frontmatter (--- delimited)
 * followed by `## User` / `## Assistant` (and similar) H2 sections.
 */
export function parseThreadMarkdown(md: string, sessionId: string): SessionNotification[] {
  if (!md || !md.trim()) return [];

  // Strip YAML frontmatter.
  let body = md;
  const fmMatch = md.match(/^---\n[\s\S]*?\n---\n+/);
  if (fmMatch) body = md.slice(fmMatch[0].length);

  const out: SessionNotification[] = [];
  const sectionRe = /^## (.+)$/gm;
  const indices: { header: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(body)) !== null) {
    indices.push({
      header: m[1].trim(),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  if (indices.length === 0) {
    out.push({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: body.trim() },
      },
    });
    return out;
  }

  for (let i = 0; i < indices.length; i++) {
    const cur = indices[i];
    const next = indices[i + 1];
    const text = body.slice(cur.bodyStart, next ? next.start : body.length).trim();
    if (!text) continue;
    const isUser = /^user\b/i.test(cur.header);
    out.push({
      sessionId,
      update: {
        sessionUpdate: isUser ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }
  return out;
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid or missing api key') ||
    lower.includes("run 'amp login'") ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('no api key found') ||
    (lower.includes('api key') && lower.includes('login flow')) ||
    (lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid')))
  );
}

export function getTerminalAuthCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const resolvedArgv1 = argv1 ? path.resolve(argv1) : '';
  if (!resolvedArgv1 || resolvedArgv1.startsWith('/$bunfs/')) {
    return execPath;
  }
  return resolvedArgv1;
}

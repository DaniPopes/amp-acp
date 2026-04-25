import { describe, it, expect } from 'bun:test';
import {
  toAcpNotifications,
  createAcpConversionState,
  kindForTool,
  titleForTool,
  parseBashResult,
  markdownEscape,
  sanitizeTitle,
  toDisplayPath,
} from '../src/to-acp.js';

describe('kindForTool', () => {
  it('maps Amp tool names to ACP kinds', () => {
    expect(kindForTool('Bash')).toBe('execute');
    expect(kindForTool('Read')).toBe('read');
    expect(kindForTool('list_directory')).toBe('read');
    expect(kindForTool('Grep')).toBe('search');
    expect(kindForTool('glob')).toBe('search');
    expect(kindForTool('edit_file')).toBe('edit');
    expect(kindForTool('create_file')).toBe('edit');
    expect(kindForTool('web_search')).toBe('fetch');
    expect(kindForTool('read_web_page')).toBe('fetch');
    expect(kindForTool('Task')).toBe('think');
    expect(kindForTool('oracle')).toBe('think');
    expect(kindForTool('mcp__custom__thing')).toBe('other');
  });
});

describe('titleForTool', () => {
  it('uses the raw command for Bash', () => {
    expect(titleForTool('Bash', { cmd: 'ls -la' })).toBe('ls -la');
    expect(titleForTool('Bash', {})).toBe('Terminal');
  });

  it('builds Read titles with line ranges', () => {
    expect(titleForTool('Read', { path: '/abs/foo.ts' })).toBe('Read /abs/foo.ts');
    expect(titleForTool('Read', { path: '/abs/foo.ts', read_range: [10, 50] })).toBe(
      'Read /abs/foo.ts (10 - 50)',
    );
    expect(titleForTool('Read', { path: '/abs/foo.ts', read_range: [10] })).toBe(
      'Read /abs/foo.ts (from line 10)',
    );
  });

  it('makes paths project-relative when cwd is given', () => {
    expect(titleForTool('Read', { path: '/repo/src/a.ts' }, '/repo')).toBe('Read src/a.ts');
    expect(titleForTool('edit_file', { path: '/repo/src/a.ts' }, '/repo')).toBe('Edit src/a.ts');
  });

  it('builds Grep and glob titles', () => {
    expect(titleForTool('Grep', { pattern: 'foo', include: '*.ts', path: 'src' })).toBe(
      'Grep "foo" --include="*.ts" src',
    );
    expect(titleForTool('glob', { filePattern: '**/*.rs', path: 'src' })).toBe(
      'Find `src` `**/*.rs`',
    );
  });

  it('builds web/oracle/task titles', () => {
    expect(titleForTool('web_search', { search_queries: ['rust async', 'tokio'] })).toBe(
      '"rust async" (+1)',
    );
    expect(titleForTool('read_web_page', { url: 'https://x.dev' })).toBe('Fetch https://x.dev');
    expect(titleForTool('oracle', { task: 'review this' })).toBe('Oracle: review this');
    expect(titleForTool('Task', { description: 'sub' })).toBe('Task: sub');
  });
});

describe('toDisplayPath', () => {
  it('makes paths relative to cwd', () => {
    expect(toDisplayPath('/repo/a/b.ts', '/repo')).toBe('a/b.ts');
  });
  it('returns absolute path when outside cwd', () => {
    expect(toDisplayPath('/etc/hosts', '/repo')).toBe('/etc/hosts');
  });
  it('returns input unchanged when no cwd', () => {
    expect(toDisplayPath('/repo/a.ts')).toBe('/repo/a.ts');
  });
});

describe('sanitizeTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeTitle('  foo\n\n  bar\t baz  ')).toBe('foo bar baz');
  });
  it('truncates very long titles with ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(256);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('markdownEscape', () => {
  it('uses ``` when input has none', () => {
    expect(markdownEscape('hello')).toBe('```\nhello\n```');
  });
  it('widens fence when input contains backticks', () => {
    const out = markdownEscape('see ```js\ncode\n```');
    expect(out.startsWith('````')).toBe(true);
    expect(out.endsWith('````')).toBe(true);
  });
});

describe('parseBashResult', () => {
  it('extracts output and exitCode from Amp JSON envelope', () => {
    const json = JSON.stringify({ output: 'hello\n', exitCode: 0 });
    expect(parseBashResult(json, false)).toEqual({ data: 'hello\n', exitCode: 0 });
  });
  it('falls back to stdout+stderr', () => {
    const json = JSON.stringify({ stdout: 'out', stderr: 'err' });
    expect(parseBashResult(json, false)).toEqual({ data: 'out\nerr', exitCode: 0 });
  });
  it('honors return_code', () => {
    const json = JSON.stringify({ output: 'oops', return_code: 2 });
    expect(parseBashResult(json, true).exitCode).toBe(2);
  });
  it('passes plain text through with fallback exit code', () => {
    expect(parseBashResult('plain output', true)).toEqual({ data: 'plain output', exitCode: 1 });
  });
  it('returns empty data for empty content', () => {
    expect(parseBashResult('', false)).toEqual({ data: '', exitCode: 0 });
  });
});

describe('toAcpNotifications: edit_file diff', () => {
  it('emits a diff content block on tool_call', () => {
    const state = createAcpConversionState('/repo');
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'edit_file',
              input: { path: '/repo/src/a.ts', old_str: 'a', new_str: 'b' },
            },
          ],
        },
      },
      'S',
      state,
    );
    expect(result).toHaveLength(1);
    expect(result[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      title: 'Edit src/a.ts',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
      locations: [{ path: '/repo/src/a.ts' }],
    });
  });

  it('preserves the diff on a successful tool_result by omitting content', () => {
    const state = createAcpConversionState('/repo');
    toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'edit_file',
              input: { path: '/repo/x', old_str: 'a', new_str: 'b' },
            },
          ],
        },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'e1', content: 'File updated', is_error: false },
          ],
        },
      },
      'S',
      state,
    );
    expect(result).toHaveLength(1);
    const upd = result[0].update as Record<string, unknown>;
    expect(upd.sessionUpdate).toBe('tool_call_update');
    expect(upd.status).toBe('completed');
    expect('content' in upd).toBe(false);
  });
});

describe('toAcpNotifications: create_file diff', () => {
  it('emits a diff with oldText:null', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'c1',
              name: 'create_file',
              input: { path: 'new.ts', content: 'hello' },
            },
          ],
        },
      },
      'S',
      createAcpConversionState(),
    );
    expect(result[0].update).toMatchObject({
      kind: 'edit',
      content: [{ type: 'diff', path: 'new.ts', oldText: null, newText: 'hello' }],
    });
  });
});

describe('toAcpNotifications: todo_write -> plan', () => {
  it('emits a plan update instead of a tool_call', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'todo_write',
              input: {
                todos: [
                  { content: 'do A', status: 'in_progress' },
                  { content: 'do B', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      'S',
      createAcpConversionState(),
    );
    expect(result).toHaveLength(1);
    const upd = result[0].update as Record<string, unknown>;
    expect(upd.sessionUpdate).toBe('plan');
    expect(upd.entries).toEqual([
      { content: 'do A', status: 'in_progress', priority: 'medium' },
      { content: 'do B', status: 'pending', priority: 'medium' },
    ]);
  });

  it('drops todo_write tool_result entirely', () => {
    const state = createAcpConversionState();
    toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'todo_write',
              input: { todos: [{ content: 'a' }] },
            },
          ],
        },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      },
      'S',
      state,
    );
    expect(result).toEqual([]);
  });
});

describe('toAcpNotifications: Bash terminal widget', () => {
  it('emits terminal_info on tool_call when supportsTerminalOutput is true', () => {
    const state = createAcpConversionState('/repo', true);
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { cmd: 'ls' } }] },
      },
      'S',
      state,
    );
    const upd = result[0].update as Record<string, unknown>;
    expect(upd.kind).toBe('execute');
    expect(upd.title).toBe('ls');
    expect(upd.content).toEqual([{ type: 'terminal', terminalId: 'b1' }]);
    expect(upd._meta).toEqual({ terminal_info: { terminal_id: 'b1', cwd: '/repo' } });
  });

  it('emits terminal_output then terminal_exit on tool_result', () => {
    const state = createAcpConversionState('/repo', true);
    toAcpNotifications(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { cmd: 'ls' } }] },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: JSON.stringify({ output: 'a\nb\n', exitCode: 0 }),
              is_error: false,
            },
          ],
        },
      },
      'S',
      state,
    );
    expect(result).toHaveLength(2);
    const out = result[0].update as Record<string, unknown>;
    const exit = result[1].update as Record<string, unknown>;
    expect(out._meta).toEqual({ terminal_output: { terminal_id: 'b1', data: 'a\nb\n' } });
    expect(exit.status).toBe('completed');
    expect(exit.content).toEqual([{ type: 'terminal', terminalId: 'b1' }]);
    expect(exit._meta).toEqual({
      terminal_exit: { terminal_id: 'b1', exit_code: 0, signal: null },
    });
  });

  it('marks tool_call as failed when exitCode is non-zero (terminal path)', () => {
    const state = createAcpConversionState('/repo', true);
    toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'b3', name: 'Bash', input: { cmd: 'false' } }],
        },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b3',
              content: JSON.stringify({ output: '', exitCode: 2 }),
              is_error: false,
            },
          ],
        },
      },
      'S',
      state,
    );
    const exit = result[result.length - 1].update as Record<string, unknown>;
    expect(exit.status).toBe('failed');
    expect((exit._meta as Record<string, unknown>).terminal_exit).toMatchObject({ exit_code: 2 });
  });

  it('marks tool_call as failed when exitCode is non-zero (fallback path)', () => {
    const state = createAcpConversionState('/repo', false);
    toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'b4', name: 'Bash', input: { cmd: 'false' } }],
        },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b4',
              content: JSON.stringify({ output: 'boom', exitCode: 3 }),
              is_error: false,
            },
          ],
        },
      },
      'S',
      state,
    );
    const upd = result[0].update as Record<string, unknown>;
    expect(upd.status).toBe('failed');
  });

  it('falls back to console fence when capability is absent', () => {
    const state = createAcpConversionState('/repo', false);
    toAcpNotifications(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { cmd: 'ls' } }] },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b2',
              content: JSON.stringify({ output: 'hello', exitCode: 0 }),
              is_error: false,
            },
          ],
        },
      },
      'S',
      state,
    );
    expect(result).toHaveLength(1);
    const upd = result[0].update as Record<string, unknown>;
    const content = upd.content as Array<{ content: { text: string } }>;
    expect(content[0].content.text).toBe('```console\nhello\n```');
  });
});

describe('toAcpNotifications: user-message filtering', () => {
  it('skips text/image blocks in user messages (echoes the client already showed)', () => {
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'echoed prompt' },
            { type: 'tool_result', tool_use_id: 'x', content: 'r', is_error: false },
          ],
        },
      },
      'S',
      createAcpConversionState(),
    );
    expect(result).toHaveLength(1);
    expect((result[0].update as Record<string, unknown>).sessionUpdate).toBe('tool_call_update');
  });

  it('skips string-content user messages entirely', () => {
    const result = toAcpNotifications(
      { type: 'user', message: { content: 'echoed' } },
      'S',
      createAcpConversionState(),
    );
    expect(result).toEqual([]);
  });
});

describe('toAcpNotifications: Read result uses adaptive fence', () => {
  it('wraps Read result via markdownEscape', () => {
    const state = createAcpConversionState();
    toAcpNotifications(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { path: '/x' } }] },
      },
      'S',
      state,
    );
    const result = toAcpNotifications(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r1',
              content: 'has ```inner``` fence',
              is_error: false,
            },
          ],
        },
      },
      'S',
      state,
    );
    const upd = result[0].update as Record<string, unknown>;
    const content = upd.content as Array<{ content: { text: string } }>;
    expect(content[0].content.text.startsWith('```')).toBe(true);
    expect(content[0].content.text).toContain('has ```inner``` fence');
  });
});

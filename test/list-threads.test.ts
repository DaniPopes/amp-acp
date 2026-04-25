import { describe, it, expect } from 'bun:test';
import { parseAmpThreadList } from '../src/list-threads.js';

const SAMPLE = JSON.stringify([
  {
    id: 'T-019dc2d0-df27-729f-bb6a-f806300ae135',
    title: 'Implement listSessions for thread list',
    updated: '2026-04-25T11:59:51.000Z',
    tree: 'file:///home/doni/github/danipopes/amp-acp',
    messageCount: 1,
  },
  {
    id: 'T-019dc2cd-0f50-7054-8fdb-8eea36ab6f56',
    title: null,
    updated: '2026-04-25T11:59:44.000Z',
    messageCount: 2,
  },
  {
    id: 'T-019dc2ae-71af-76ec-87ed-fd130912e45f',
    title: 'Bump AMP SDK and debug thinking mode',
    updated: '2026-04-25T11:53:00.000Z',
    tree: 'file:///tmp/work',
    messageCount: 14,
  },
]);

describe('parseAmpThreadList', () => {
  it('parses the threads list JSON', () => {
    const out = parseAmpThreadList(SAMPLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      threadId: 'T-019dc2d0-df27-729f-bb6a-f806300ae135',
      title: 'Implement listSessions for thread list',
      updatedAt: '2026-04-25T11:59:51.000Z',
      messageCount: 1,
      cwd: '/home/doni/github/danipopes/amp-acp',
    });
    expect(out[1].title).toBeNull();
    expect(out[1].cwd).toBe(process.cwd()); // falls back when no tree
    expect(out[2].cwd).toBe('/tmp/work');
    expect(out[2].messageCount).toBe(14);
  });

  it('returns [] for empty input', () => {
    expect(parseAmpThreadList('')).toHaveLength(0);
  });
});

import { describe, it, expect } from 'bun:test';
import { parseAmpThreadList, relativeToIso } from '../src/list-threads.js';

const SAMPLE = `Title                                         Last Updated  Visibility  Messages  Thread ID                             
────────────────────────────────────────────  ────────────  ──────────  ────────  ──────────────────────────────────────
Implement listSessions for thread list        9s ago        Private     1         T-019dc2d0-df27-729f-bb6a-f806300ae135
AMP agent thread importing issues             16s ago       Private     2         T-019dc2cd-0f50-7054-8fdb-8eea36ab6f56
Bump AMP SDK and debug thinking mode          7m ago        Private     14        T-019dc2ae-71af-76ec-87ed-fd130912e45f
`;

describe('parseAmpThreadList', () => {
  it('parses the threads list table', () => {
    const out = parseAmpThreadList(SAMPLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      threadId: 'T-019dc2d0-df27-729f-bb6a-f806300ae135',
      title: 'Implement listSessions for thread list',
      lastUpdated: '9s ago',
      visibility: 'Private',
      messages: 1,
    });
    expect(out[2].messages).toBe(14);
  });

  it('returns [] for empty input', () => {
    expect(parseAmpThreadList('')).toHaveLength(0);
  });

  it('returns [] when separator row is missing', () => {
    expect(parseAmpThreadList('Title  Thread ID\nx  T-abc\n')).toHaveLength(0);
  });
});

describe('relativeToIso', () => {
  const now = new Date('2026-04-25T12:00:00.000Z');
  it('converts seconds', () => {
    expect(relativeToIso('9s ago', now)).toBe('2026-04-25T11:59:51.000Z');
  });
  it('converts minutes', () => {
    expect(relativeToIso('5m ago', now)).toBe('2026-04-25T11:55:00.000Z');
  });
  it('converts hours', () => {
    expect(relativeToIso('2h ago', now)).toBe('2026-04-25T10:00:00.000Z');
  });
  it('converts days', () => {
    expect(relativeToIso('1d ago', now)).toBe('2026-04-24T12:00:00.000Z');
  });
  it('returns undefined for garbage', () => {
    expect(relativeToIso('whenever')).toBeUndefined();
  });
});

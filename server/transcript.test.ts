import { describe, expect, it } from 'vitest';
import { TranscriptParser } from './transcript';

describe('transcript parser', () => {
  it('unwraps long pastes stored as <pasted_content>', () => {
    const p = new TranscriptParser();
    p.feed({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-05T10:00:00Z',
      message: { role: 'user', content: '\n\n<pasted_content id="f322">\nLine 1\nLine 2\n</pasted_content id="f322">\n' },
    });
    const u = p.items.find((i) => i.kind === 'user');
    expect(u && u.kind === 'user' && u.text).toBe('Line 1\nLine 2');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-safeguard-1';
const NOTE = 'Your response above was stopped by a safety classifier — this is not a tool or API error. '
  + 'The rest of it was withheld, and tool calls in it that had not finished did not run. '
  + 'Do not produce that content again, even reworded.';

/**
 * Mirage review: when Anthropic's safeguards stop a reply, Claude Code retries
 * once and leaves the model a note. The live stream does not flag that note
 * `isMeta`, so it rendered as the user's own message. The refused reply itself
 * carries the reason; it becomes one notice and the note stays hidden.
 */
test('a refused reply becomes one safeguard_stopped notice with its category', () => {
  const rows = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'u-refused',
    timestamp: '2026-11-06T06:14:58.000Z',
    message: {
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'Cyber safeguards flagged this message. See https://support.claude.com/en/articles/1-x.',
      },
    },
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'safeguard_stopped');
  assert.equal(rows[0].id, 'u-refused_safeguard');
  assert.deepEqual(rows[0].safeguardStop, {
    category: 'cyber',
    explanation: 'Cyber safeguards flagged this message. See https://support.claude.com/en/articles/1-x.',
  });
});

test('a refused reply without stop_details still becomes a notice', () => {
  const [row] = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'u-refused-2',
    message: { role: 'assistant', content: [], stop_reason: 'refusal' },
  }, SESSION_ID);

  assert.equal(row.kind, 'safeguard_stopped');
  assert.deepEqual(row.safeguardStop, { category: null, explanation: null });
});

test('the note for the model is never shown as the user, live or from history', () => {
  const live = provider.normalizeMessage({
    type: 'user',
    uuid: 'u-note-live',
    message: { role: 'user', content: NOTE },
  }, SESSION_ID);
  const liveBlocks = provider.normalizeMessage({
    type: 'user',
    uuid: 'u-note-live-blocks',
    message: { role: 'user', content: [{ type: 'text', text: NOTE }] },
  }, SESSION_ID);
  const persisted = provider.normalizeMessage({
    type: 'user',
    uuid: 'u-note-meta',
    isMeta: true,
    turnCompanion: true,
    refusedMessageId: 'msg_1',
    message: { role: 'user', content: NOTE },
  }, SESSION_ID);

  for (const rows of [live, liveBlocks, persisted]) {
    assert.equal(rows.filter((row) => row.kind === 'text' && row.role === 'user').length, 0);
    // The refused reply is not always persisted; the note alone still marks the stop.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'safeguard_stopped');
  }
});

test('an ordinary reply is untouched', () => {
  const rows = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'u-ok',
    message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Готово.' }], stop_reason: 'end_turn' },
  }, SESSION_ID);

  assert.equal(rows.some((row) => row.kind === 'safeguard_stopped'), false);
  assert.equal(rows.some((row) => row.kind === 'text' && row.content === 'Готово.'), true);
});

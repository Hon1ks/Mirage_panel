import assert from 'node:assert/strict';

import { test } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { NormalizedMessage } from '@/shared/types';

function notice(id: string, minute: number, category: string | null): NormalizedMessage {
  return {
    id,
    kind: 'safeguard_stopped',
    sessionId: 's1',
    provider: 'claude',
    timestamp: new Date(2026, 10, 6, 7, minute).toISOString(),
    safeguardStop: { category, explanation: category ? 'Cyber safeguards flagged this message.' : null },
  } as NormalizedMessage;
}

test('the refused reply and the note to the model fold into one notice keeping the category (review)', () => {
  const converted = normalizedToChatMessages([notice('a_safeguard', 14, 'cyber'), notice('b_safeguard', 14, null)]);
  assert.equal(converted.length, 1);
  assert.deepEqual(converted[0].safeguardStop, { category: 'cyber', explanation: 'Cyber safeguards flagged this message.' });
});

test('a note that arrives alone (refused reply not persisted) still gives a notice', () => {
  const converted = normalizedToChatMessages([notice('n_safeguard', 48, null)]);
  assert.equal(converted.length, 1);
  assert.deepEqual(converted[0].safeguardStop, { category: null, explanation: null });
});

test('two separate stops stay two notices', () => {
  const user = { id: 'u', kind: 'text', role: 'user', content: 'ещё вопрос', sessionId: 's1', provider: 'claude', timestamp: new Date(2026, 10, 6, 7, 20).toISOString() } as NormalizedMessage;
  const converted = normalizedToChatMessages([notice('n1_safeguard', 10, null), user, notice('n2_safeguard', 21, 'cyber')]);
  assert.equal(converted.filter((message) => message.safeguardStop).length, 2);
});

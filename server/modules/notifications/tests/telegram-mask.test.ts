import assert from 'node:assert/strict';
import test from 'node:test';

import { maskSecrets } from '@/modules/notifications/services/telegram-notifier.service.js';
import { formatCalendarReminder } from '@/modules/notifications/services/telegram-calendar-reminders.service.js';
import type { CalendarItem } from '@/shared/types.js';

test('secrets in a command waiting for approval are masked before Telegram (review fix Н-11)', () => {
  const cases: Array<[string, string[]]> = [
    ['curl -H "Authorization: Bearer abcdef1234567890" https://api.example.com', ['abcdef1234567890']],
    ['curl -H "authorization: token ghp_AAAAbbbbCCCCdddd1111" x', ['ghp_AAAAbbbbCCCCdddd1111']],
    ['export OPENAI_API_KEY=sk-proj-1234567890abcdef && run', ['sk-proj-1234567890abcdef']],
    ['DB_PASSWORD=hunter2secret psql', ['hunter2secret']],
    ['mysql --password=s3cr3tpw -u root', ['s3cr3tpw']],
    ['tool --api-key XYZ123456789 call', ['XYZ123456789']],
    ['git clone https://user:p4ssw0rd@github.com/x/y.git', ['p4ssw0rd']],
    ['echo 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_ | bot', ['AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_']],
    ['aws s3 ls # AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE']],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fw', ['SflKxwRJSMeKKF2QT4fw']],
    ['cat key <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt\n-----END OPENSSH PRIVATE KEY-----\nEOF', ['b3BlbnNzaC1rZXkt']],
  ];
  for (const [command, secrets] of cases) {
    const masked = maskSecrets(command);
    for (const secret of secrets) assert.ok(!masked.includes(secret), `${command} → ${masked}`);
    assert.ok(masked.includes('•••'), masked);
  }
});

test('ordinary commands stay readable', () => {
  for (const command of ['rm -rf build/', 'git commit -m "fix" --author "Ivan <i@x.ru>"', 'npm run build', 'ls -la /home/mirage/projects', 'cat session-notes.md']) {
    assert.equal(maskSecrets(command), command);
  }
});

test('calendar reminders carry the name and @handle, never the phone', () => {
  const item = {
    id: 'e1', type: 'call', title: 'Позвонить партнёру', startsAt: '2026-11-10T09:00:00Z',
    contact: { name: 'Иван', phone: '+7 900 123-45-67', telegram: '@ivan' },
  } as unknown as CalendarItem;
  const text = formatCalendarReminder(item, Date.parse('2026-11-10T08:30:00Z'), 'Europe/Moscow', null);
  assert.ok(text.includes('Иван') && text.includes('@ivan'), text);
  assert.ok(!text.includes('900') && !text.includes('45-67'), text);
});

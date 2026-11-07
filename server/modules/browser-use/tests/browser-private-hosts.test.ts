import assert from 'node:assert/strict';
import test from 'node:test';

import { isPrivateBrowserHost } from '@/modules/browser-use/browser-use.service.js';

test('the agent browser refuses this machine, private networks and cloud metadata (review fix Н-13)', () => {
  for (const host of [
    'localhost', 'app.localhost', 'printer.local', 'metadata.google.internal',
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '[::1]', '::1', '[fd00::1]', 'fe80::1', '[::ffff:127.0.0.1]', '::ffff:169.254.169.254', 'LOCALHOST.',
  ]) {
    assert.equal(isPrivateBrowserHost(host), true, host);
  }
});

test('public hosts stay open', () => {
  for (const host of ['example.com', 'github.com', '8.8.8.8', '172.32.0.1', '[2606:4700::1111]', 'localhost.example.com']) {
    assert.equal(isPrivateBrowserHost(host), false, host);
  }
});

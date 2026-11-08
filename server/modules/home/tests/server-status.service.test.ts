import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerStatusService, parseMeminfo, readServiceList } from '@/modules/home/services/server-status.service.js';

test('the service list comes from the env only: valid unit names, unique, at most eight', () => {
  assert.deepEqual(readServiceList(' caddy, cloudcli ,caddy,,mirage-sandbox.service'), ['caddy', 'cloudcli', 'mirage-sandbox.service']);
  assert.deepEqual(readServiceList('ok; rm -rf /,a b,$(x),--help,-x'), []);
  assert.deepEqual(readServiceList(Array.from({ length: 12 }, (_, i) => `u${i}`).join(',')).length, 8);
  assert.deepEqual(readServiceList(undefined), []);
});

test('meminfo gives available memory and swap in bytes', () => {
  const parsed = parseMeminfo('MemTotal:  1937000 kB\nMemFree:  100000 kB\nMemAvailable:   800000 kB\nSwapTotal: 10485756 kB\nSwapFree:  8000000 kB\n');
  assert.deepEqual(parsed, { availableBytes: 800000 * 1024, swapTotalBytes: 10485756 * 1024, swapFreeBytes: 8000000 * 1024 });
  assert.deepEqual(parseMeminfo(''), { availableBytes: null, swapTotalBytes: null, swapFreeBytes: null });
});

test('a reading combines os, meminfo, disk and services and is cached briefly', async () => {
  let now = 1_000_000;
  let queried: string[][] = [];
  const service = createServerStatusService({
    env: { MIRAGE_HOME_SERVICES: 'caddy,cloudcli,ghost' },
    now: () => now,
    readMeminfo: async () => 'MemAvailable: 500000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    readRootDisk: async () => ({ totalBytes: 100, freeBytes: 40 }),
    queryServices: async (units) => { queried.push(units); return 'active\nfailed\n'; },
    osInfo: () => ({ uptimeSec: 3600.4, load: [0.5, 0.4, 0.3], cpus: 2, totalMem: 2_000_000_000, freeMem: 100 }),
  });

  const first = await service.getStatus();
  assert.equal(first.uptimeSec, 3600);
  assert.deepEqual(first.memory, { totalBytes: 2_000_000_000, availableBytes: 500000 * 1024 });
  assert.equal(first.swap, null);
  assert.deepEqual(first.disk, { totalBytes: 100, freeBytes: 40 });
  assert.deepEqual(first.services, [{ name: 'caddy', state: 'active' }, { name: 'cloudcli', state: 'failed' }, { name: 'ghost', state: 'unknown' }]);

  now += 5_000;
  await service.getStatus();
  assert.equal(queried.length, 1);
  now += 10_000;
  await service.getStatus();
  assert.equal(queried.length, 2);
});

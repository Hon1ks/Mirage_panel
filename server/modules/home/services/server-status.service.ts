import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

/**
 * The home «Сервер» widget (DarkSettings 03 «Нагрузка, диск, службы»): load,
 * memory, swap, the root disk, uptime and the state of a few systemd services.
 * Read-only: Node built-ins, `/proc/meminfo` and `systemctl is-active` with
 * fixed arguments (no shell). Which services are listed comes from the server's
 * `MIRAGE_HOME_SERVICES` (comma-separated unit names), never from a request.
 */

/** A service's `systemctl is-active` answer: active, inactive, failed, activating… or unknown. */
type ServiceState = { name: string; state: string };

/** What the widget draws; byte counts are raw numbers, the client formats them. */
export type ServerStatus = {
  uptimeSec: number;
  load: [number, number, number];
  cpus: number;
  memory: { totalBytes: number; availableBytes: number };
  swap: { totalBytes: number; freeBytes: number } | null;
  disk: { totalBytes: number; freeBytes: number } | null;
  services: ServiceState[];
  /** When this was read (ISO); the answer is cached briefly, so tabs share one reading. */
  readAt: string;
};

const CACHE_MS = 10_000;
const MAX_SERVICES = 8;
const UNIT_NAME = /^[A-Za-z0-9@_][A-Za-z0-9@._:-]{0,79}$/;
const SYSTEMCTL_TIMEOUT_MS = 5_000;

type ServerStatusDependencies = {
  env: NodeJS.ProcessEnv;
  now(): number;
  readMeminfo(): Promise<string>;
  readRootDisk(): Promise<{ totalBytes: number; freeBytes: number } | null>;
  /** `systemctl is-active` for the units, one answer line per unit, in order. */
  queryServices(units: string[]): Promise<string>;
  osInfo(): { uptimeSec: number; load: [number, number, number]; cpus: number; totalMem: number; freeMem: number };
};

/** Unit names from `MIRAGE_HOME_SERVICES`: trimmed, valid, unique, at most eight. Exported for the home tests. */
export function readServiceList(raw: string | undefined): string[] {
  const names = (raw ?? '').split(',').map((name) => name.trim()).filter((name) => UNIT_NAME.test(name));
  return [...new Set(names)].slice(0, MAX_SERVICES);
}

/** `MemAvailable`, `SwapTotal`, `SwapFree` from `/proc/meminfo` (kB → bytes); missing fields are null. Exported for the home tests. */
export function parseMeminfo(text: string): { availableBytes: number | null; swapTotalBytes: number | null; swapFreeBytes: number | null } {
  const read = (field: string) => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  return { availableBytes: read('MemAvailable'), swapTotalBytes: read('SwapTotal'), swapFreeBytes: read('SwapFree') };
}

/** Creates the service; the module wiring injects the real system readers. Used by the home routes. */
export function createServerStatusService(dependencies: ServerStatusDependencies) {
  let cached: { at: number; status: ServerStatus } | null = null;

  async function readServices(): Promise<ServiceState[]> {
    const units = readServiceList(dependencies.env.MIRAGE_HOME_SERVICES);
    if (units.length === 0) return [];
    let answer = '';
    try {
      answer = await dependencies.queryServices(units);
    } catch {
      answer = '';
    }
    const lines = answer.split('\n').map((line) => line.trim());
    return units.map((name, index) => ({ name, state: /^[a-z-]{1,20}$/.test(lines[index] ?? '') ? lines[index] : 'unknown' }));
  }

  return {
    async getStatus(): Promise<ServerStatus> {
      const nowMs = dependencies.now();
      if (cached && nowMs - cached.at < CACHE_MS) return cached.status;

      const info = dependencies.osInfo();
      const meminfo = parseMeminfo(await dependencies.readMeminfo().catch(() => ''));
      const [disk, services] = await Promise.all([dependencies.readRootDisk().catch(() => null), readServices()]);
      const status: ServerStatus = {
        uptimeSec: Math.round(info.uptimeSec),
        load: info.load,
        cpus: Math.max(1, info.cpus),
        // MemAvailable counts reclaimable cache; os.freemem() alone would read a healthy server as full.
        memory: { totalBytes: info.totalMem, availableBytes: meminfo.availableBytes ?? info.freeMem },
        swap: meminfo.swapTotalBytes ? { totalBytes: meminfo.swapTotalBytes, freeBytes: meminfo.swapFreeBytes ?? 0 } : null,
        disk,
        services,
        readAt: new Date(nowMs).toISOString(),
      };
      cached = { at: nowMs, status };
      return status;
    },
  };
}

/** The server's own reading, as the home routes serve it at `GET /api/home/server`. */
export const serverStatusService = createServerStatusService({
  env: process.env,
  now: () => Date.now(),
  readMeminfo: () => readFile('/proc/meminfo', 'utf8'),
  readRootDisk: async () => {
    const stats = await statfs('/');
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  },
  // `is-active` exits non-zero when any unit is not active; its stdout still has every answer.
  queryServices: (units) => new Promise((resolve) => {
    execFile('systemctl', ['is-active', '--', ...units], { timeout: SYSTEMCTL_TIMEOUT_MS }, (_error, stdout) => {
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  }),
  osInfo: () => {
    const [one, five, fifteen] = os.loadavg();
    return { uptimeSec: os.uptime(), load: [one, five, fifteen], cpus: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem() };
  },
});

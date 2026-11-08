import { Gauge, Panel, SectionRuler } from '@/modules/kabina';
import type { ServerStatus } from '@/shared/types';

type HomeServerProps = {
  index: string;
  status: ServerStatus | null;
  isPhone: boolean;
};

const GIB = 1024 ** 3;

function formatGib(bytes: number): string {
  const value = bytes / GIB;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ГБ`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days} дн ${hours} ч`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours} ч ${minutes} мин`;
}

/** Arc colour by how full: sage when calm, sand when busy, brick near the cap. */
function toneFor(percent: number | null): 'sage' | 'sand' | 'brick' {
  if (percent === null || percent < 70) return 'sage';
  return percent < 90 ? 'sand' : 'brick';
}

const SERVICE_LED: Record<string, string> = {
  active: 'kb-led-run',
  activating: 'kb-led-wait',
  reloading: 'kb-led-wait',
  failed: 'kb-led-warn',
};

const SERVICE_STATE: Record<string, string> = {
  active: 'работает',
  inactive: 'остановлена',
  failed: 'упала',
  activating: 'запускается',
  reloading: 'перезагружается',
  deactivating: 'останавливается',
  unknown: 'нет данных',
};

/**
 * Used by HomeScreen: the «Сервер» widget (DarkSettings 03 «Нагрузка, диск,
 * службы») — load, memory and root-disk dials, uptime and swap, and the services
 * the server lists in `MIRAGE_HOME_SERVICES`.
 */
export default function HomeServer({ index, status, isPhone }: HomeServerProps) {
  const loadPercent = status ? Math.min(100, (status.load[0] / status.cpus) * 100) : null;
  const memoryPercent = status && status.memory.totalBytes > 0
    ? ((status.memory.totalBytes - status.memory.availableBytes) / status.memory.totalBytes) * 100
    : null;
  const diskPercent = status?.disk && status.disk.totalBytes > 0
    ? ((status.disk.totalBytes - status.disk.freeBytes) / status.disk.totalBytes) * 100
    : null;

  const gauges = [
    {
      key: 'load',
      name: 'Нагрузка',
      caption: status ? `${status.load[0].toFixed(2)} · ${status.cpus} ядра` : 'нет данных',
      percent: loadPercent,
    },
    {
      key: 'memory',
      name: 'Память',
      caption: status ? `${formatGib(status.memory.totalBytes - status.memory.availableBytes)} из ${formatGib(status.memory.totalBytes)}` : 'нет данных',
      percent: memoryPercent,
    },
    {
      key: 'disk',
      name: 'Диск /',
      caption: status?.disk ? `свободно ${formatGib(status.disk.freeBytes)}` : 'нет данных',
      percent: diskPercent,
    },
  ];

  const swapUsed = status?.swap ? status.swap.totalBytes - status.swap.freeBytes : null;

  return (
    <Panel as="section" className="mh-limits mh-server kb-rise kb-d4" aria-labelledby="mh-h-server" data-phone={isPhone ? '' : undefined}>
      <SectionRuler id="mh-h-server" index={index} title="СЕРВЕР" scale="none" touch={isPhone} />

      <div className="mh-gauges" aria-busy={status ? undefined : true} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {gauges.map((spec) => (
          <Gauge key={spec.key} name={spec.name} caption={spec.caption} percent={spec.percent} tone={toneFor(spec.percent)} compact={isPhone} />
        ))}
      </div>

      {status && (
        <div className="mh-server-meta kb-m">
          <span>работает {formatUptime(status.uptimeSec)}</span>
          {status.swap && swapUsed !== null && <span>swap {formatGib(swapUsed)} из {formatGib(status.swap.totalBytes)}</span>}
          <span>load {status.load.map((value) => value.toFixed(2)).join(' · ')}</span>
        </div>
      )}

      {status && status.services.length > 0 && (
        <ul className="mh-server-services">
          {status.services.map((service) => (
            <li key={service.name}>
              <span className={`kb-led ${SERVICE_LED[service.state] ?? 'kb-led-idle'}`} style={{ width: 6, height: 6 }} />
              <span className="kb-m mh-server-name">{service.name}</span>
              <span className="mh-server-state">{SERVICE_STATE[service.state] ?? service.state}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

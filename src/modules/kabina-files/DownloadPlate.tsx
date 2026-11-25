import { createPortal } from 'react-dom';

import { Button } from '@/modules/kabina';
import { DownloadGlyph } from '@/modules/kabina-files/FilesIcons';
import type { DownloadProgress } from '@/modules/kabina-files/utils/downloads';
import { formatBytes } from '@/modules/kabina-files/utils/fileKinds';

/**
 * Used by FilesScreen while a file or a zip downloads: a plate at the bottom of the
 * screen with the name, a progress bar, «45 % · 12 МБ из 27 МБ» and «Отмена». While
 * the server is still packing a zip the bar runs without a percentage.
 */
export function DownloadPlate({ download }: { download: DownloadProgress }) {
  const { name, phase, loaded, total } = download;
  const percent = phase === 'loading' && total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  const detail = phase === 'preparing'
    ? 'Собираю архив на сервере…'
    : percent !== null && total
      ? `${percent} % · ${formatBytes(loaded)} из ${formatBytes(total)}`
      : formatBytes(loaded);

  // In `.kb-portal`, where the Kabina colour tokens live (it is rendered into <body>).
  return createPortal(
    <div className="kb-portal">
      <div className="kf-dl kb-bz kb-fadein" role="status" aria-live="polite">
        <DownloadGlyph size={16} color="var(--kb-signal)" />
        <div className="kf-dl-body">
          <div className="kf-dl-line">
            <span className="kf-dl-name">{name}</span>
            <span className="kb-m kf-dl-detail">{detail}</span>
          </div>
          <div
            className="kf-dl-bar"
            role="progressbar"
            aria-label={`Скачивание ${name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            data-indeterminate={percent === null ? '' : undefined}
          >
            <span style={percent !== null ? { width: `${percent}%` } : undefined} />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={download.cancel}>Отмена</Button>
      </div>
    </div>,
    document.body,
  );
}

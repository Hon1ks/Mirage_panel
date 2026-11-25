import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/modules/kabina';
import { DownloadGlyph } from '@/modules/kabina-files/FilesIcons';
import type { DownloadProgress } from '@/modules/kabina-files/utils/downloads';
import { formatBytes } from '@/modules/kabina-files/utils/fileKinds';

/** The percentage done, or null while it cannot be told (a zip being packed, an unknown size). */
function percentOf({ phase, loaded, total }: DownloadProgress): number | null {
  return phase === 'loading' && total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
}

/**
 * Used by FilesScreen while a file or a zip downloads from the row menu or the batch bar:
 * a plate at the bottom of the screen with the name, a progress bar, «45 % · 12 МБ из
 * 27 МБ» and «Отмена». While the server is still packing a zip the bar runs without a
 * percentage. The preview's own «Скачать» shows its progress in the button instead.
 */

export function DownloadPlate({ download }: { download: DownloadProgress }) {
  const { name, phase, loaded, total } = download;
  const percent = percentOf(download);
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

/**
 * Used by FilePreview for «Скачать» / «Скачать zip»: the button is its own progress bar —
 * it fills from the left with «45 %», a zip being packed runs a stripe with «Собираю…»;
 * a second tap cancels.
 */
export function DownloadButton({ download, idle, onStart, disabled, title }: {
  download: DownloadProgress | null;
  /** The button as it reads before a download («⤓ Скачать»). */
  idle: ReactNode;
  onStart: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (!download) {
    return (
      <Button variant="ghost" className="kf-dlbtn" disabled={disabled} title={title} onClick={onStart}>
        {idle}
      </Button>
    );
  }
  const percent = percentOf(download);
  const label = download.phase === 'preparing' ? 'Собираю…' : percent !== null ? `${percent} %` : formatBytes(download.loaded);
  return (
    <Button
      variant="ghost"
      className="kf-dlbtn"
      data-active=""
      data-indeterminate={percent === null ? '' : undefined}
      aria-label={`Скачивается ${download.name}: ${label}. Нажмите, чтобы отменить`}
      title="Нажмите, чтобы отменить"
      style={percent !== null ? { '--kf-dl-p': `${percent}%` } as CSSProperties : undefined}
      onClick={download.cancel}
    >
      <span className="kf-dlbtn-fill" aria-hidden="true" />
      <span className="kf-dlbtn-text">
        <span className="kb-m">{label}</span>
        <span className="kf-dlbtn-cancel" aria-hidden="true">✕</span>
      </span>
    </Button>
  );
}

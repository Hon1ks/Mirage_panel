import { useEffect, useMemo, useState } from 'react';

import { Button, Modal } from '@/modules/kabina';
import { ChevronGlyph, FolderGlyph } from '@/modules/kabina-files/FilesIcons';
import { filesErrorSentence } from '@/modules/kabina-files/utils/filesErrors';
import { isWithin } from '@/modules/kabina-files/utils/fileKinds';
import { api, readApiJson } from '@/shared/api';
import type { KabinaFileEntry, KabinaProjectRef } from '@/shared/types';
import { pluralRu } from '@/shared/utils';

type TransferModalProps = {
  mode: 'copy' | 'move';
  /** Names of what is copied or moved, for the caption. */
  names: string[];
  projects: KabinaProjectRef[];
  /** Where the picker starts: the project and folder the entries are in. */
  startProjectId: string;
  startFolder: string;
  /** Picked folders: they cannot be chosen as the destination, nor anything inside them. */
  pickedFolders: string[];
  onSubmit: (target: { projectId: string; folder: string }) => Promise<void>;
  onCancel: () => void;
};

type FolderList = { state: 'loading' } | { state: 'error'; text: string } | { state: 'ready'; folders: KabinaFileEntry[]; more: number };

function basename(target: string): string {
  return target.split('/').filter(Boolean).pop() ?? target;
}

/**
 * Used by FilesScreen for «Копировать в…» and «Переместить в…»: pick a project, walk
 * its folders, and copy or move the picked entries there. The server never
 * overwrites — a taken name gets « (2)».
 */
export function TransferModal({ mode, names, projects, startProjectId, startFolder, pickedFolders, onSubmit, onCancel }: TransferModalProps) {
  const [projectId, setProjectId] = useState(startProjectId);
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? null;
  const [folder, setFolder] = useState(startFolder);
  const [list, setList] = useState<FolderList>({ state: 'loading' });
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setList({ state: 'loading' });
    void (async () => {
      try {
        const body = await readApiJson<{ data: { entries: KabinaFileEntry[]; total: number } }>(await api.kabinaFiles.folder(folder, { limit: 500 }));
        if (cancelled) return;
        const folders = body.data.entries.filter((entry) => entry.type === 'directory');
        setList({ state: 'ready', folders, more: Math.max(0, body.data.total - body.data.entries.length) });
      } catch (loadError) {
        if (!cancelled) setList({ state: 'error', text: filesErrorSentence(loadError, 'Папка не открылась') });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // «demo-site // docs // img»: from the project folder down to the one being looked at.
  const crumbs = useMemo(() => {
    if (!project) return [];
    const rest = folder === project.path ? [] : folder.slice(project.path.length).split('/').filter(Boolean);
    const list = [{ label: project.displayName || basename(project.path), path: project.path }];
    let walked = project.path;
    for (const segment of rest) {
      walked = `${walked}/${segment}`;
      list.push({ label: segment, path: walked });
    }
    return list;
  }, [folder, project]);

  const isPickedOrInside = (target: string) => pickedFolders.some((picked) => picked === target || isWithin(picked, target));
  const blocked = isPickedOrInside(folder);
  const verb = mode === 'copy' ? 'Копировать' : 'Переместить';
  const what = names.length === 1 ? `«${names[0]}»` : `${names.length} ${pluralRu(names.length, ['объект', 'объекта', 'объектов'])}`;

  const submit = async () => {
    if (!project || blocked || isSending) return;
    setIsSending(true);
    setError(null);
    try {
      await onSubmit({ projectId: project.projectId, folder });
    } catch (submitError) {
      setError(filesErrorSentence(submitError, mode === 'copy' ? 'Не скопировалось' : 'Не перенеслось'));
      setIsSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'copy' ? 'КОПИРОВАТЬ В…' : 'ПЕРЕМЕСТИТЬ В…'}
      maxWidth={560}
      footer={(
        <div className="kf-clash-actions">
          <Button variant="ghost" onClick={onCancel}>Отмена</Button>
          <Button variant="pri" disabled={!project || blocked || isSending} onClick={() => void submit()}>
            {isSending ? (mode === 'copy' ? 'Копирую…' : 'Переношу…') : `${verb} сюда`}
          </Button>
        </div>
      )}
    >
      <div className="kf-move">
        <p className="kf-clash-lead">
          {`${verb} ${what} в папку `}
          <span className="kf-clash-name">{`${basename(folder)}/`}</span>
          {project && project.projectId !== startProjectId && <> проекта <span className="kf-clash-name">{project.displayName}</span></>}
          . Если имя занято — рядом появится копия с « (2)», ничего не перезапишется.
        </p>

        <label className="kb-m kf-move-label" htmlFor="kf-move-project">ПРОЕКТ</label>
        <select
          id="kf-move-project"
          className="kb-field kf-move-select"
          value={projectId}
          onChange={(event) => {
            const next = projects.find((candidate) => candidate.projectId === event.target.value);
            if (!next) return;
            setProjectId(next.projectId);
            setFolder(next.path);
          }}
        >
          {projects.map((candidate) => (
            <option key={candidate.projectId} value={candidate.projectId}>{candidate.displayName}</option>
          ))}
        </select>

        <nav aria-label="Папка назначения">
          <ol className="kb-m kf-crumbs kf-move-crumbs">
            {crumbs.map((crumb, index) => (
              <li key={crumb.path}>
                {index > 0 && <span className="kf-crumb-sep" aria-hidden="true">//</span>}
                {index < crumbs.length - 1 ? (
                  <button type="button" className="kf-crumb" onClick={() => setFolder(crumb.path)}>{crumb.label}</button>
                ) : (
                  <span className="kf-crumb" aria-current="location">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <div className="kf-move-list" role="group" aria-label="Папки внутри">
          {list.state === 'loading' && <div className="kb-m kf-more">гружу папку…</div>}
          {list.state === 'error' && <div className="kb-m kf-more" style={{ color: 'var(--kb-signal-text)' }}>{list.text}</div>}
          {list.state === 'ready' && list.folders.length === 0 && <div className="kb-m kf-more">внутри папок нет — можно класть сюда</div>}
          {list.state === 'ready' && list.folders.map((entry) => {
            const disabled = isPickedOrInside(entry.path);
            return (
              <button
                key={entry.path}
                type="button"
                className="kf-row"
                disabled={disabled}
                title={disabled ? 'Это то, что переносится, — внутрь самой себя нельзя' : undefined}
                onClick={() => setFolder(entry.path)}
              >
                <FolderGlyph color="var(--kb-sand)" />
                <span className="kf-row-name"><span className="kf-row-label">{entry.name}</span></span>
                <ChevronGlyph />
              </button>
            );
          })}
          {list.state === 'ready' && list.more > 0 && <div className="kb-m kf-more">{`и ещё ${list.more} — показаны первые 500`}</div>}
        </div>

        {blocked && <p className="kf-clash-problem" role="alert">Папку нельзя положить в неё саму — выбери другую.</p>}
        {error && <p className="kf-clash-problem" role="alert">{error}</p>}
        {project && !isWithin(project.path, folder) && folder !== project.path && (
          <p className="kf-clash-problem" role="alert">Класть можно только внутрь проекта.</p>
        )}
      </div>
    </Modal>
  );
}

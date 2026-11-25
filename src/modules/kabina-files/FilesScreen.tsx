import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import '@/modules/kabina-files/kabinaFiles.css';
import { Button, kabinaChatPath, NO_AUTOFILL, Sheet, StatusShape } from '@/modules/kabina';
import FilePreview from '@/modules/kabina-files/FilePreview';
import { FilesContextMenu } from '@/modules/kabina-files/FilesContextMenu';
import type { FilesMenuItem } from '@/modules/kabina-files/FilesContextMenu';
import {
  ArchiveGlyph,
  BranchGlyph,
  CheckGlyph,
  CopyGlyph,
  DownloadGlyph,
  EyeGlyph,
  FilePlusGlyph,
  FileTypeGlyph,
  FilterGlyph,
  FolderGlyph,
  FolderPlusGlyph,
  MoveGlyph,
  PencilGlyph,
  SelectGlyph,
  ServerGlyph,
  UploadGlyph,
  ZipGlyph,
} from '@/modules/kabina-files/FilesIcons';
import FilesTree from '@/modules/kabina-files/FilesTree';
import { TransferModal } from '@/modules/kabina-files/TransferModal';
import { UploadConflictModal } from '@/modules/kabina-files/UploadConflictModal';
import { useFolderPages } from '@/modules/kabina-files/hooks/useFolderPages';
import { usePhoneLayout } from '@/modules/kabina-files/hooks/usePhoneLayout';
import { filesErrorText } from '@/modules/kabina-files/utils/filesErrors';
import { expectedSize, isAbort, readWithProgress, saveBlob } from '@/modules/kabina-files/utils/downloads';
import type { DownloadProgress } from '@/modules/kabina-files/utils/downloads';
import { DownloadPlate } from '@/modules/kabina-files/DownloadPlate';
import { commonProjectsFolder, extensionTag, folderOfSelection, foldersToReveal, formatModified, isWithin, resolveRevealPath } from '@/modules/kabina-files/utils/fileKinds';
import { api, readApiJson } from '@/shared/api';
import { writeDraftText } from '@/shared/chatDrafts';
import { useHomeOverviewFeed } from '@/shared/hooks/useHomeOverviewFeed';
import type { KabinaFileEntry, KabinaProjectRef, KabinaUploadConflict } from '@/shared/types';
import { pluralRu, tildePath } from '@/shared/utils';

/** Per-browser list of files looked at lately («03 НЕДАВНИЕ»). */
const RECENT_STORAGE_KEY = 'mirage.kabina.files.recent';
const MAX_RECENT = 4;
/** «02 ИЗБРАННЫЕ ПРОЕКТЫ» stays a short block; the rest is one link away in «Все проекты». */
const MAX_FAVOURITES = 6;
const GIB = 1024 ** 3;

type RecentFile = { entry: KabinaFileEntry; projectId: string | null; projectName: string; at: number };

type Note =
  | { kind: 'archived'; name: string; projectId: string; archivedPath: string; originalPath: string }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string };

type GitState = { branch: string | null; changed: Set<string> };

/** «Копировать в…» / «Переместить в…» waiting for a destination. */
type PendingTransfer = { mode: 'copy' | 'move'; entries: KabinaFileEntry[] };

/** The right-click menu of a tree row. */
type RowMenu = { entry: KabinaFileEntry; x: number; y: number };

/** The archive's name from `Content-Disposition` (`filename*=UTF-8''…`), else `fallback`. */
function readDownloadName(response: Response, fallback: string): string {
  const header = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (!encoded) return fallback;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return fallback;
  }
}

/** An upload the server refused over taken names, waiting in the conflict window for new ones. */
type PendingUpload = { folder: string; files: File[]; names: string[]; conflicts: KabinaUploadConflict[]; attempt: number };

type PlaceId = 'projects' | 'downloads' | 'archive' | 'server';

/**
 * The taken names of a refused upload (409 FILE_EXISTS from the File Tree upload), or null
 * for any other error. Read off the thrown ApiRequestError by shape, not by class.
 */
function readUploadConflicts(error: unknown): KabinaUploadConflict[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (code !== 'FILE_EXISTS' || typeof details !== 'object' || details === null) return null;
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return null;
  const valid = conflicts.filter((conflict): conflict is KabinaUploadConflict => (
    typeof conflict === 'object' && conflict !== null
    && typeof conflict.index === 'number'
    && typeof conflict.name === 'string'
    && typeof conflict.suggestedName === 'string'
  ));
  return valid.length > 0 ? valid : null;
}

function basename(target: string): string {
  return target.split('/').filter(Boolean).pop() ?? target;
}

function parentOf(target: string): string {
  const slash = target.replace(/\/+$/, '').lastIndexOf('/');
  return slash > 0 ? target.slice(0, slash) : '/';
}

function readRecent(): RecentFile[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]') as RecentFile[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

type FilesScreenProps = {
  projects: KabinaProjectRef[];
  /** `?project=` of `/files`: the tree opens in that project and writing is allowed inside it. */
  routeProjectId: string | null;
  /** The project list is still on its way: an empty `projects` does not yet mean «no projects». */
  isLoadingProjects?: boolean;
};

/**
 * Used by the project-workspace module for `/files?project=`: DarkFiles on
 * the authors' file APIs plus the Kabina folder pages — places, lazy tree,
 * preview by type, git marks, upload with drag and drop, new folder, rename,
 * «В архив» instead of delete, and «Открыть в чате» with an @-link.
 */
export function FilesScreen({ projects, routeProjectId, isLoadingProjects = false }: FilesScreenProps) {
  const navigate = useNavigate();
  // `?file=` from ⌘K «Открыть в файлах»: the tree opens down to that file.
  const [searchParams] = useSearchParams();
  const fileParam = searchParams.get('file');
  const project = projects.find((candidate) => candidate.projectId === routeProjectId) ?? null;
  const projectsFolder = useMemo(() => commonProjectsFolder(projects.map((candidate) => candidate.path)), [projects]);
  // `&line=` from a `path:line` link in the chat: the preview opens around that line of the `?file=`.
  const lineParam = Number(searchParams.get('line'));
  const focusLine = Number.isInteger(lineParam) && lineParam > 0 ? lineParam : null;
  const revealTarget = fileParam ? resolveRevealPath(fileParam, project?.path ?? projectsFolder) : null;
  // Hidden entries (dot files) are listed only on request.
  const [showHidden, setShowHidden] = useState(false);
  const { folders, meta, loadFolder, loadMore } = useFolderPages(showHidden);
  // The folder the tree starts from: the project, a place, or a crumb the user climbed to.
  const [rootPath, setRootPath] = useState<string | null>(project?.path ?? projectsFolder);
  // Folders opened in the tree.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The entry shown in the preview.
  const [selected, setSelected] = useState<KabinaFileEntry | null>(null);
  // Phone: the preview is a bottom sheet, opened by a file picked by hand (not the README chosen on entry).
  const isPhone = usePhoneLayout();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // A path to select once its folder page arrives (after «Новая папка» or a rename).
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  // Name filter over loaded folders.
  const [filter, setFilter] = useState('');
  // «Новая папка» / «Новый файл» row, what it creates, where (null — the current folder) and the name typed.
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [newKind, setNewKind] = useState<'directory' | 'file'>('directory');
  const [newTarget, setNewTarget] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  // Entries ticked for a batch action, and whether «Выбрать» is on (a click ticks instead of opening).
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  // The right-click menu, a copy / move waiting for its destination, and a rename asked from the menu.
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<PendingTransfer | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  // A zip being built on the server, for the buttons' label.
  const [isZipping, setIsZipping] = useState(false);
  // The download in flight (file or zip): the plate at the bottom shows its progress and «Отмена».
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  // The line above the tree: archived (with «Вернуть»), done, or an error.
  const [note, setNote] = useState<Note | null>(null);
  // Branch and changed files of the open project; null outside a repository.
  const [git, setGit] = useState<GitState | null>(null);
  // A file is being dragged over the window.
  const [isDragging, setIsDragging] = useState(false);
  // Upload in flight, for the button label.
  const [isUploading, setIsUploading] = useState(false);
  // Mirage: the upload refused because a name is taken (the server never overwrites) — the
  // conflict window asks for other names and sends the same files again.
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  // Files looked at lately in this browser.
  const [recent, setRecent] = useState<RecentFile[]>(readRecent);
  // Favourites' live signals, from the shared home overview poll.
  const { overview: homeOverview } = useHomeOverviewFeed();
  const projectStates = useMemo(() => {
    const states: Record<string, 'run' | 'wait'> = {};
    for (const item of homeOverview?.activity ?? []) {
      if (!item.projectId) continue;
      if (item.state === 'waiting') states[item.projectId] = 'wait';
      else if (!states[item.projectId]) states[item.projectId] = 'run';
    }
    return states;
  }, [homeOverview]);
  // Entry counts of the places («Проекты 47»).
  const [placeCounts, setPlaceCounts] = useState<Record<string, number>>({});
  // Clock for «сегодня 13:58»; refreshed a minute at a time.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The path of the `?file=` reveal in progress, so it is told apart from a plain pending selection.
  const revealRef = useRef<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const readProjectId = routeProjectId ?? projects[0]?.projectId ?? null;
  const places = meta?.places ?? null;

  // A new `?project=` (or the project list arriving) re-roots the tree.
  useEffect(() => {
    const nextRoot = project?.path ?? projectsFolder ?? places?.root ?? null;
    setRootPath(nextRoot);
    setExpanded(new Set());
    setSelected(null);
    setFilter('');
    setNote(null);
    setChecked(new Set());
    setIsSelecting(false);
    // `places` only matters when there are no projects at all.
  }, [project?.path, projectsFolder]);

  // `?file=`: root the tree, open every folder above the file, load their pages and select the file once it arrives.
  // Declared after the re-root effect so that, in the same commit, the reveal wins.
  useEffect(() => {
    if (!fileParam) return;
    const absolute = resolveRevealPath(fileParam, project?.path ?? projectsFolder);
    if (!absolute) return;
    // Without `?project=` the tree opens in the project that holds the file (shorter than the whole «Проекты»).
    const owner = project ?? projects.filter((candidate) => isWithin(candidate.path, absolute)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
    const preferredRoot = owner?.path ?? projectsFolder ?? places?.root ?? null;
    // A file outside the usual root is shown from the folder that holds it.
    const base = preferredRoot && foldersToReveal(preferredRoot, absolute).length > 0 ? preferredRoot : parentOf(absolute);
    const chain = foldersToReveal(base, absolute);
    if (chain.length === 0) return;
    revealRef.current = absolute;
    setRootPath(base);
    setFilter('');
    setExpanded((current) => new Set([...current, ...chain.slice(1)]));
    for (const folderPath of chain) void loadFolder(folderPath);
    setPendingSelect(absolute);
    // Re-runs for a new `?file=` or when the project list changes the root; `loadFolder` is left out so that toggling hidden files does not re-root the tree.
  }, [fileParam, project?.path, projectsFolder, places?.root]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Without any project the tree starts at the workspace root, learned from the first page.
  // While the list is loading it is not known yet: no root page, no «Сервер» flash.
  useEffect(() => {
    if (isLoadingProjects || projects.length > 0 || rootPath) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<{ data: { places: { root: string } } }>(await api.kabinaFiles.folder('~', { limit: 1 }));
        // Projects may have arrived meanwhile; they win.
        if (!cancelled) setRootPath((current) => current ?? body.data.places.root);
      } catch {
        // The tree shows its own error once a root is known.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoadingProjects, projects.length, rootPath]);

  useEffect(() => {
    if (rootPath) void loadFolder(rootPath);
  }, [loadFolder, rootPath, showHidden]);

  // Reopen folders that were open when hidden files were toggled (their pages were dropped).
  useEffect(() => {
    for (const folderPath of expanded) void loadFolder(folderPath);
    // Only on the toggle: opening a folder loads it in `toggleFolder`.
  }, [showHidden]);

  // The first visit to a folder selects its README (or CLAUDE.md), like the mock-up's open document.
  useEffect(() => {
    if (!rootPath || selected || revealRef.current) return;
    const entries = folders[rootPath]?.entries;
    if (!entries) return;
    const readme = entries.find((entry) => /^readme\.md$/i.test(entry.name)) ?? entries.find((entry) => entry.name === 'CLAUDE.md');
    if (readme) setSelected(readme);
  }, [folders, rootPath, selected, pendingSelect]);

  useEffect(() => {
    if (!pendingSelect) return;
    const parentPath = parentOf(pendingSelect);
    const parent = folders[parentPath];
    const found = parent?.entries.find((entry) => entry.path === pendingSelect);
    if (found) {
      setSelected(found);
      setPendingSelect(null);
      if (revealRef.current === pendingSelect) {
        // Same as a click on the file: recent list, and the preview into view on a phone. The page is
        // not scrolled down to the row on a desktop: the preview beside the tree would leave the screen.
        revealRef.current = null;
        rememberRecent(found);
        setIsSheetOpen(true);
      }
      return;
    }
    if (!parent || parent.isLoading || parent.error) return;
    // The file may sit past the first page: bring in the next one; when everything is loaded and it is still absent, give up quietly.
    if (parent.entries.length > 0 && parent.entries.length < parent.total) void loadMore(parentPath);
    else if (revealRef.current === pendingSelect) {
      revealRef.current = null;
      setPendingSelect(null);
    }
  }, [folders, pendingSelect]);

  const refreshGit = useCallback(async () => {
    if (!routeProjectId || !project) {
      setGit(null);
      return;
    }
    try {
      const response = await api.git.status(routeProjectId);
      const data = await response.json() as { branch?: string; modified?: string[]; added?: string[]; untracked?: string[]; error?: string };
      if (data.error) {
        setGit(null);
        return;
      }
      const changed = new Set(
        [...(data.modified ?? []), ...(data.added ?? []), ...(data.untracked ?? [])]
          .map((relative) => `${project.path}/${relative.replace(/\/$/, '')}`),
      );
      setGit({ branch: data.branch ?? null, changed });
    } catch {
      setGit(null);
    }
  }, [project, routeProjectId]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);


  const placeList = useMemo(() => {
    if (!places) return [];
    const list: Array<{ id: PlaceId; name: string; path: string }> = [];
    if (projectsFolder) list.push({ id: 'projects', name: basename(projectsFolder), path: projectsFolder });
    list.push({ id: 'downloads', name: 'Загрузки', path: `${places.root}/Downloads` });
    list.push({ id: 'archive', name: 'Архив', path: places.archive });
    list.push({ id: 'server', name: 'Сервер', path: places.root });
    return list;
  }, [places, projectsFolder]);

  // Counts of the places, asked once per place (a one-entry page carries the total).
  useEffect(() => {
    for (const place of placeList) {
      if (placeCounts[place.path] !== undefined) continue;
      void (async () => {
        try {
          const body = await readApiJson<{ data: { total: number } }>(await api.kabinaFiles.folder(place.path, { limit: 1 }));
          setPlaceCounts((current) => ({ ...current, [place.path]: body.data.total }));
        } catch {
          setPlaceCounts((current) => ({ ...current, [place.path]: -1 }));
        }
      })();
    }
  }, [placeCounts, placeList]);

  // «/» jumps to the filter, as the mock-up's key hint says.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, [contenteditable="true"]'))) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const currentFolder = rootPath ? folderOfSelection(selected?.path ?? null, selected?.type === 'directory', rootPath) : null;
  const canWriteIn = (target: string | null) => Boolean(project && target && isWithin(project.path, target));
  const canEditEntry = Boolean(project && selected && isWithin(project.path, selected.path) && selected.path !== project.path);

  const rememberRecent = (entry: KabinaFileEntry) => {
    const item: RecentFile = { entry, projectId: routeProjectId, projectName: project ? basename(project.path) : basename(parentOf(entry.path)), at: Date.now() };
    setRecent((current) => {
      const next = [item, ...current.filter((existing) => existing.entry.path !== entry.path)].slice(0, MAX_RECENT);
      try {
        window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the list lives until reload.
      }
      return next;
    });
  };

  const toggleFolder = (entry: KabinaFileEntry) => {
    setSelected(entry);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        void loadFolder(entry.path);
      }
      return next;
    });
  };

  const selectFile = (entry: KabinaFileEntry) => {
    setSelected(entry);
    rememberRecent(entry);
    // On a phone the preview slides up as a sheet over the tree.
    setIsSheetOpen(true);
  };

  const goTo = (folderPath: string) => {
    // A crumb or place that is exactly a project opens that project (writing allowed there).
    const asProject = projects.find((candidate) => candidate.path === folderPath);
    if (asProject && asProject.projectId !== routeProjectId) {
      navigate(`/files?project=${encodeURIComponent(asProject.projectId)}`);
      return;
    }
    setRootPath(folderPath);
    setExpanded(new Set());
    setSelected(null);
    setFilter('');
  };

  const reloadFolder = async (folderPath: string) => {
    await loadFolder(folderPath, true);
    void refreshGit();
  };

  /** Opens the «Новая папка» / «Новый файл» row for `folder` (null — the current folder). */
  const openNewItem = (kind: 'directory' | 'file', folder: string | null = null) => {
    setNewKind(kind);
    setNewTarget(folder);
    setNewFolderName('');
    setIsNewFolderOpen(true);
  };

  const createFolder = async () => {
    const folder = newTarget ?? currentFolder;
    const isFile = newKind === 'file';
    const name = newFolderName.trim() || (isFile ? 'новый-файл.md' : 'новая-папка');
    if (!routeProjectId || !folder || !canWriteIn(folder)) return;
    try {
      await readApiJson(await api.createFile(routeProjectId, { path: folder, type: newKind, name }));
      setIsNewFolderOpen(false);
      setNewFolderName('');
      setExpanded((current) => new Set(current).add(folder));
      await reloadFolder(folder);
      setPendingSelect(`${folder}/${name}`);
      // A new file opens in the preview right away, ready for «Открыть целиком».
      if (isFile) setIsSheetOpen(true);
    } catch (error) {
      setNote({ kind: 'error', text: `${isFile ? 'Файл не создан' : 'Папка не создана'}: ${filesErrorText(error, 'ошибка на сервере')}` });
    }
  };

  /** The project an entry belongs to (the deepest one holding it), not counting the project folder itself. */
  const ownerOf = (target: string): KabinaProjectRef | null => (
    projects
      .filter((candidate) => isWithin(candidate.path, target) && candidate.path !== target)
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  );
  const canEditPath = (target: string) => Boolean(ownerOf(target));
  const editHint = 'Только файлы и папки внутри проектов';

  const toggleChecked = (entry: KabinaFileEntry) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const clearChecked = () => {
    setChecked(new Set());
    setIsSelecting(false);
  };

  /** Ticked entries as loaded in the tree (a ticked one that has since gone is dropped). */
  const checkedEntries = useMemo(() => {
    const byPath = new Map<string, KabinaFileEntry>();
    for (const folder of Object.values(folders)) for (const entry of folder.entries) byPath.set(entry.path, entry);
    return [...checked].map((target) => byPath.get(target)).filter((entry): entry is KabinaFileEntry => Boolean(entry));
  }, [checked, folders]);

  /** Entries split by the project that holds them (the server acts on one project at a time). */
  const groupByOwner = (entries: KabinaFileEntry[]) => {
    const groups = new Map<string, KabinaFileEntry[]>();
    for (const entry of entries) {
      const owner = ownerOf(entry.path);
      if (!owner) continue;
      groups.set(owner.projectId, [...(groups.get(owner.projectId) ?? []), entry]);
    }
    return groups;
  };

  const countText = (count: number) => `${count} ${pluralRu(count, ['объект', 'объекта', 'объектов'])}`;

  const transfer = async (target: { projectId: string; folder: string }) => {
    if (!pendingTransfer) return;
    const { mode, entries } = pendingTransfer;
    let done = 0;
    let unchanged = 0;
    let lastTo: string | null = null;
    // Errors go to the window, which stays open with the reason.
    for (const [projectId, group] of groupByOwner(entries)) {
      const body = await readApiJson<{ data: { items: Array<{ to: string }>; unchanged: number } }>(await api.kabinaFiles.transfer(projectId, {
        paths: group.map((entry) => entry.path), toProjectId: target.projectId, toFolder: target.folder, mode,
      }));
      done += body.data.items.length;
      unchanged += body.data.unchanged;
      lastTo = body.data.items.at(-1)?.to ?? lastTo;
    }
    setPendingTransfer(null);
    clearChecked();
    const verb = mode === 'copy' ? 'Скопировано' : 'Перенесено';
    const where = `${basename(target.folder)}/`;
    setNote({ kind: 'ok', text: unchanged && !done ? `Уже лежит в ${where} — ничего не перенесено` : `${verb} ${countText(done)} в ${where}${unchanged ? ` (${unchanged} уже были там)` : ''}` });
    if (mode === 'move') {
      if (selected && entries.some((entry) => isWithin(entry.path, selected.path))) setSelected(null);
      for (const folder of new Set(entries.map((entry) => parentOf(entry.path)))) void loadFolder(folder, true);
    }
    if (folders[target.folder]) await reloadFolder(target.folder);
    else void refreshGit();
    // One copy in sight: shown, so it is clear where it went.
    if (done === 1 && lastTo && rootPath && isWithin(rootPath, lastTo) && folders[target.folder]) setPendingSelect(lastTo);
  };

  const downloadZip = async (entries: KabinaFileEntry[]) => {
    const groups = groupByOwner(entries);
    if (groups.size === 0) {
      setNote({ kind: 'error', text: 'Архивом можно скачать только то, что лежит в проектах.' });
      return;
    }
    setIsZipping(true);
    const controller = new AbortController();
    try {
      for (const [projectId, group] of groups) {
        const fallbackName = group.length === 1 ? `${group[0].name}.zip` : 'файлы.zip';
        // The server packs the whole archive before the first byte: «Собираю архив…» until then.
        setDownload({ name: fallbackName, phase: 'preparing', loaded: 0, total: null, cancel: () => controller.abort() });
        const response = await api.kabinaFiles.zip(projectId, group.map((entry) => entry.path), { signal: controller.signal });
        // An error answer is JSON: readApiJson turns it into the server's reason.
        if (!response.ok) await readApiJson(response);
        const skipped = Number(response.headers.get('X-Kabina-Skipped') ?? 0);
        const name = readDownloadName(response, fallbackName);
        const blob = await readWithProgress(response, expectedSize(response, null), (loaded, total) => {
          setDownload({ name, phase: 'loading', loaded, total, cancel: () => controller.abort() });
        });
        saveBlob(blob, name);
        if (skipped > 0) {
          setNote({ kind: 'ok', text: `Архив скачан; пропущено ${skipped}: ссылки и секреты (ключи, .env, базы панели) в архив не кладутся` });
        }
      }
    } catch (error) {
      setNote(isAbort(error)
        ? { kind: 'ok', text: 'Скачивание архива отменено' }
        : { kind: 'error', text: `Архив не собран: ${filesErrorText(error, 'ошибка на сервере')}` });
    } finally {
      setIsZipping(false);
      setDownload(null);
    }
  };

  const downloadFile = async (entry: KabinaFileEntry) => {
    const owner = ownerOf(entry.path);
    const readId = owner?.projectId ?? readProjectId;
    if (!readId) return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    setDownload({ name: entry.name, phase: 'loading', loaded: 0, total: entry.size || null, cancel });
    try {
      const response = await api.readFileBlob(readId, entry.path, { signal: controller.signal });
      if (!response.ok) await readApiJson(response);
      // The server streams without a length: the tree's size of the file stands in for it.
      const blob = await readWithProgress(response, expectedSize(response, entry.size), (loaded, total) => {
        setDownload({ name: entry.name, phase: 'loading', loaded, total, cancel });
      });
      saveBlob(blob, entry.name);
    } catch (error) {
      setNote(isAbort(error)
        ? { kind: 'ok', text: `Скачивание ${entry.name} отменено` }
        : { kind: 'error', text: `Не скачалось: ${filesErrorText(error, 'ошибка на сервере')}` });
    } finally {
      setDownload(null);
    }
  };

  const archiveMany = async (entries: KabinaFileEntry[]) => {
    if (entries.length === 1) {
      const [entry] = entries;
      const owner = ownerOf(entry.path);
      if (!owner) return;
      try {
        const body = await readApiJson<{ data: { originalPath: string; archivedPath: string } }>(await api.kabinaFiles.archive(owner.projectId, entry.path));
        setNote({ kind: 'archived', name: entry.name, projectId: owner.projectId, ...body.data });
        if (selected && isWithin(entry.path, selected.path)) setSelected(null);
        clearChecked();
        await reloadFolder(parentOf(entry.path));
      } catch (error) {
        setNote({ kind: 'error', text: `Не перенёс в архив: ${filesErrorText(error, 'ошибка на сервере')}` });
      }
      return;
    }
    let done = 0;
    let failed = 0;
    for (const entry of entries) {
      const owner = ownerOf(entry.path);
      if (!owner) {
        failed += 1;
        continue;
      }
      try {
        await readApiJson(await api.kabinaFiles.archive(owner.projectId, entry.path));
        done += 1;
      } catch {
        failed += 1;
      }
    }
    if (selected && entries.some((entry) => isWithin(entry.path, selected.path))) setSelected(null);
    clearChecked();
    setNote(failed
      ? { kind: 'error', text: `В архив: ${done} из ${entries.length}, ${failed} не получилось` }
      : { kind: 'ok', text: `${countText(done)} перенесено в ~/.claude/archive — не удалены, вернуть можно из «Архив»` });
    for (const folder of new Set(entries.map((entry) => parentOf(entry.path)))) void loadFolder(folder, true);
    void refreshGit();
  };

  const copyPathOf = async (entry: KabinaFileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      setNote({ kind: 'ok', text: `Путь скопирован: ${tildePath(entry.path)}` });
    } catch {
      setNote({ kind: 'error', text: 'Браузер не дал доступ к буферу обмена.' });
    }
  };

  /** What the right-click menu of `entry` offers; actions that need a project are greyed with the reason. */
  const menuItems = (entry: KabinaFileEntry): FilesMenuItem[] => {
    const isFolder = entry.type === 'directory';
    const editable = canEditPath(entry.path);
    const writableHere = isFolder && canWriteIn(entry.path);
    const items: FilesMenuItem[] = [];
    if (isFolder) {
      items.push({ kind: 'item', label: expanded.has(entry.path) ? 'Свернуть' : 'Открыть', icon: <FolderGlyph size={14} />, onSelect: () => toggleFolder(entry) });
      items.push({ kind: 'item', label: 'Новый файл здесь', icon: <FilePlusGlyph size={14} />, disabled: !writableHere, hint: writeHint, onSelect: () => openNewItem('file', entry.path) });
      items.push({ kind: 'item', label: 'Новая папка здесь', icon: <FolderPlusGlyph size={14} />, disabled: !writableHere, hint: writeHint, onSelect: () => openNewItem('directory', entry.path) });
    } else {
      items.push({ kind: 'item', label: 'Открыть', icon: <FileTypeGlyph kind="doc" color="currentColor" />, onSelect: () => selectFile(entry) });
    }
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item', label: 'Переименовать', icon: <PencilGlyph />, disabled: !(project && isWithin(project.path, entry.path) && entry.path !== project.path), hint: 'Переименовать можно внутри открытого проекта',
      onSelect: () => {
        setSelected(entry);
        setIsSheetOpen(true);
        setRenameFor(entry.path);
      },
    });
    items.push({ kind: 'item', label: 'Копировать в…', icon: <CopyGlyph />, disabled: !editable, hint: editHint, onSelect: () => setPendingTransfer({ mode: 'copy', entries: [entry] }) });
    items.push({ kind: 'item', label: 'Переместить в…', icon: <MoveGlyph />, disabled: !editable, hint: editHint, onSelect: () => setPendingTransfer({ mode: 'move', entries: [entry] }) });
    items.push(isFolder
      ? { kind: 'item', label: 'Скачать zip', icon: <ZipGlyph />, disabled: !editable, hint: editHint, onSelect: () => void downloadZip([entry]) }
      : { kind: 'item', label: 'Скачать', icon: <DownloadGlyph size={14} />, onSelect: () => void downloadFile(entry) });
    items.push({ kind: 'item', label: 'Копировать путь', icon: <CopyGlyph />, onSelect: () => void copyPathOf(entry) });
    items.push({
      kind: 'item', label: checked.has(entry.path) ? 'Снять выбор' : 'Выбрать', icon: <SelectGlyph size={14} />,
      onSelect: () => {
        setIsSelecting(true);
        toggleChecked(entry);
      },
    });
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'В архив', icon: <ArchiveGlyph size={14} />, danger: true, disabled: !editable, hint: editHint, onSelect: () => void archiveMany([entry]) });
    return items;
  };

  // `names` — what each file is saved as: its own name, or the one given in the conflict window.
  const sendUpload = async (folder: string, files: File[], names: string[], attempt = 0) => {
    if (!routeProjectId) return;
    const formData = new FormData();
    formData.append('targetPath', folder);
    formData.append('requestedFileCount', String(files.length));
    for (const file of files) formData.append('files', file);
    formData.append('relativePaths', JSON.stringify(names));
    setIsUploading(true);
    try {
      const body = await readApiJson<{ uploadedCount?: number }>(await api.kabinaFiles.upload(routeProjectId, formData));
      const count = body.uploadedCount ?? files.length;
      const renamed = names.filter((name, index) => name !== files[index].name);
      const renamedText = renamed.length === 1 ? ` — как ${renamed[0]}` : renamed.length > 1 ? ` — ${renamed.length} под новыми именами` : '';
      setNote({ kind: 'ok', text: `Загружено ${count} ${pluralRu(count, ['файл', 'файла', 'файлов'])} в ${basename(folder)}/${renamedText}` });
      setExpanded((current) => new Set(current).add(folder));
      await reloadFolder(folder);
      // A file saved under a new name is shown, so it is clear which one is the new one.
      if (renamed.length === 1) setPendingSelect(`${folder}/${renamed[0]}`);
    } catch (error) {
      const conflicts = readUploadConflicts(error);
      if (conflicts) {
        setNote(null);
        setPendingUpload({ folder, files, names, conflicts, attempt: attempt + 1 });
        return;
      }
      setNote({ kind: 'error', text: `Не загрузилось: ${filesErrorText(error, 'ошибка на сервере')}` });
    } finally {
      setIsUploading(false);
    }
  };

  const upload = async (files: File[]) => {
    if (!routeProjectId || !currentFolder || !canWriteIn(currentFolder) || files.length === 0) {
      if (files.length) setNote({ kind: 'error', text: `Загружать можно только в папку открытого проекта — выбери проект ${isPhone ? 'выше' : 'слева'}.` });
      return;
    }
    await sendUpload(currentFolder, files, files.map((file) => file.name));
  };

  const uploadUnderNewNames = (renames: Map<number, string>) => {
    if (!pendingUpload) return;
    const { folder, files, names, attempt } = pendingUpload;
    setPendingUpload(null);
    void sendUpload(folder, files, names.map((name, index) => renames.get(index) ?? name), attempt);
  };

  const archiveSelected = async () => {
    if (!selected || !routeProjectId || !canEditEntry) return;
    const entry = selected;
    try {
      const body = await readApiJson<{ data: { originalPath: string; archivedPath: string } }>(await api.kabinaFiles.archive(routeProjectId, entry.path));
      setNote({ kind: 'archived', name: entry.name, projectId: routeProjectId, ...body.data });
      setSelected(null);
      await reloadFolder(parentOf(entry.path));
    } catch (error) {
      setNote({ kind: 'error', text: `Не перенёс в архив: ${filesErrorText(error, 'ошибка на сервере')}` });
    }
  };

  const undoArchive = async () => {
    if (note?.kind !== 'archived') return;
    try {
      await readApiJson(await api.kabinaFiles.restore(note.projectId, note.archivedPath, note.originalPath));
      setNote(null);
      await reloadFolder(parentOf(note.originalPath));
      setPendingSelect(note.originalPath);
    } catch (error) {
      setNote({ kind: 'error', text: `Не вернулось: ${filesErrorText(error, 'ошибка на сервере')}` });
    }
  };

  const renameSelected = async (newName: string) => {
    if (!selected || !routeProjectId) return;
    try {
      const body = await readApiJson<{ newPath: string }>(await api.renameFile(routeProjectId, { oldPath: selected.path, newName }));
      await reloadFolder(parentOf(selected.path));
      setPendingSelect(body.newPath);
    } catch (error) {
      setNote({ kind: 'error', text: `Не переименовано: ${filesErrorText(error, 'ошибка на сервере')}` });
    }
  };

  const openInChat = (question: string) => {
    if (!selected) return;
    const chatProject = project ?? projects.find((candidate) => isWithin(candidate.path, selected.path)) ?? null;
    if (!chatProject) {
      setNote({ kind: 'error', text: 'Этот файл не лежит ни в одном проекте — открой его проект или добавь папку как проект.' });
      return;
    }
    const reference = isWithin(chatProject.path, selected.path) && selected.path !== chatProject.path
      ? selected.path.slice(chatProject.path.length + 1)
      : selected.path;
    // The new chat of the project starts with the @-link (and the question) already typed.
    writeDraftText(`project:${chatProject.projectId}`, `@${reference} ${question}`.trimEnd() + (question ? '' : ' '));
    navigate(kabinaChatPath(chatProject.projectId), { state: { kabinaNewChat: true } });
  };

  // Drag and drop anywhere on the screen uploads into the current folder.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current += 1;
      setIsDragging(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      void upload(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  });

  // Crumbs: from the projects folder («Проекты // demo-site // docs») or from the home folder («~ // Downloads»).
  const crumbs = useMemo(() => {
    if (!currentFolder) return [];
    const base = projectsFolder && isWithin(projectsFolder, currentFolder)
      ? projectsFolder
      : places && isWithin(places.root, currentFolder) ? places.root : '/';
    const baseLabel = base === places?.root ? '~' : base === '/' ? '/' : basename(base);
    const rest = currentFolder === base ? [] : currentFolder.slice(base.length).split('/').filter(Boolean);
    const list = [{ label: baseLabel, path: base }];
    let walked = base;
    for (const segment of rest) {
      walked = `${walked === '/' ? '' : walked}/${segment}`;
      list.push({ label: segment, path: walked });
    }
    return list;
  }, [currentFolder, places, projectsFolder]);

  const folderTitle = currentFolder ? (currentFolder === places?.root ? 'Сервер' : basename(currentFolder)) : 'Файлы';
  const rootLabel = rootPath ? basename(rootPath) : '';
  const changedCount = git?.changed.size ?? 0;
  const disk = meta?.disk ?? null;
  const writable = canWriteIn(currentFolder);
  const writeHint = project ? 'Только внутри открытого проекта' : `Выбери проект ${isPhone ? 'выше' : 'слева'} — загружать и создавать можно внутри проекта`;
  const favourites = projects.filter((candidate) => candidate.isStarred);
  // The place the tree is in: the deepest place containing the tree's root (a project inside «Проекты» marks «Проекты»).
  const currentPlaceId = rootPath
    ? [...placeList].sort((left, right) => right.path.length - left.path.length).find((place) => isWithin(place.path, rootPath))?.id ?? null
    : null;

  const preview = (
    <FilePreview
      entry={selected}
      readProjectId={readProjectId}
      canEdit={canEditEntry}
      isChanged={Boolean(selected && git?.changed.has(selected.path))}
      folderCount={rootPath ? folders[rootPath]?.total ?? null : null}
      displayPath={selected ? tildePath(selected.path) : ''}
      nowMs={nowMs}
      onOpenInChat={openInChat}
      onRename={renameSelected}
      onArchive={() => void archiveSelected()}
      renameFor={renameFor}
      onRenameStarted={() => setRenameFor(null)}
      canTransfer={Boolean(selected && canEditPath(selected.path))}
      onTransfer={(mode) => selected && setPendingTransfer({ mode, entries: [selected] })}
      onZip={() => selected && void downloadZip([selected])}
      isZipping={isZipping}
      onDownloadProgress={setDownload}
      focusLine={selected && selected.path === revealTarget ? focusLine : null}
    />
  );

  return (
    <div className="kf-screen">
      <section className="kf-head kb-rise" aria-label="Текущая папка">
        <div className="kf-head-main">
          <nav aria-label="Путь">
            <ol className="kb-m kf-crumbs">
              {crumbs.map((crumb, index) => (
                <li key={crumb.path}>
                  {index > 0 && <span className="kf-crumb-sep" aria-hidden="true">//</span>}
                  {index < crumbs.length - 1 ? (
                    <button type="button" className="kf-crumb" onClick={() => goTo(crumb.path)}>{crumb.label}</button>
                  ) : (
                    <span className="kf-crumb" aria-current="location">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="kf-title-line">
            <h1 className="kb-t kf-h1">{folderTitle}</h1>
            <div className="kb-m kf-facts">
              {git?.branch && <span className="kf-fact"><BranchGlyph />{git.branch}</span>}
              {git && (
                <span className="kf-fact" data-tone={changedCount ? 'sand' : undefined}>
                  <span className="kf-m-badge" aria-hidden="true">M</span>
                  {changedCount
                    ? `${changedCount} ${pluralRu(changedCount, ['изменение', 'изменения', 'изменений'])} не ${pluralRu(changedCount, ['закоммичено', 'закоммичены', 'закоммичены'])}`
                    : 'всё закоммичено'}
                </span>
              )}
              {disk && disk.totalBytes > 0 && (
                <span className="kf-fact" style={{ gap: 8 }}>
                  ДИСК
                  <span className="kf-disk" aria-hidden="true"><span style={{ width: `${Math.round((disk.usedBytes / disk.totalBytes) * 100)}%` }} /></span>
                  <span><span style={{ color: 'var(--kb-text)' }}>{Math.round(disk.usedBytes / GIB)}</span> / {Math.round(disk.totalBytes / GIB)} ГБ</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="kf-head-actions">
          <div className="kf-head-buttons">
            <Button
              variant="ghost"
              aria-expanded={isNewFolderOpen}
              disabled={!writable}
              title={writable ? undefined : writeHint}
              onClick={() => {
                if (isNewFolderOpen && newKind === 'directory' && !newTarget) setIsNewFolderOpen(false);
                else openNewItem('directory');
              }}
            >
              <FolderPlusGlyph />Новая папка
            </Button>
            <Button
              variant="ghost"
              disabled={!writable}
              title={writable ? undefined : writeHint}
              onClick={() => openNewItem('file')}
            >
              <FilePlusGlyph />Новый файл
            </Button>
            <Button variant="pri" disabled={!writable || isUploading} title={writable ? undefined : writeHint} onClick={() => uploadRef.current?.click()}>
              <UploadGlyph />{isUploading ? 'Загружаю…' : 'Загрузить'}
            </Button>
            <input
              ref={uploadRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void upload(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
          </div>
          <span className="kb-m kf-hint">
            {writable ? `или перетащи файлы в окно → ${basename(currentFolder ?? '')}/` : writeHint}
          </span>
        </div>
      </section>

      <div className="kf-columns">
        <aside className="kf-places kb-rise kb-d1" aria-label="Быстрые места">
          <section className="kf-section" aria-labelledby="kf-h-places">
            <div className="kf-ruler">
              <span className="kb-m kf-ruler-n" aria-hidden="true">01</span>
              <h2 id="kf-h-places" className="kb-m kf-ruler-title">МЕСТА</h2>
              <span className="kf-ruler-scale" aria-hidden="true" />
            </div>
            <div className="kf-list">
              {placeList.filter((place) => placeCounts[place.path] !== -1).map((place) => {
                const isCurrent = place.id === currentPlaceId;
                const icon = place.id === 'projects' ? <FolderGlyph size={15} />
                  : place.id === 'downloads' ? <DownloadGlyph size={15} />
                  : place.id === 'archive' ? <ArchiveGlyph size={15} />
                  : <ServerGlyph size={15} />;
                const count = placeCounts[place.path];
                return (
                  <button key={place.id} type="button" className="kf-place" aria-current={isCurrent ? 'true' : undefined} onClick={() => goTo(place.path)}>
                    <span className="kf-place-icon">{icon}</span>
                    <span className="kf-place-text">
                      <span className="kf-pname">{place.name}</span>
                      <span className="kb-m kf-psub">{place.id === 'server' ? place.path : tildePath(place.path)}</span>
                    </span>
                    {place.id !== 'server' && count !== undefined && <span className="kb-m kf-psub">{count}</span>}
                  </button>
                );
              })}
            </div>
          </section>

          {favourites.length > 0 && (
            <section className="kf-section" aria-labelledby="kf-h-favs">
              <div className="kf-ruler">
                <span className="kb-m kf-ruler-n" aria-hidden="true">02</span>
                <h2 id="kf-h-favs" className="kb-m kf-ruler-title">ИЗБРАННЫЕ ПРОЕКТЫ</h2>
                <span className="kf-ruler-scale" aria-hidden="true" />
              </div>
              <div className="kf-list" data-tight="">
                {favourites.slice(0, MAX_FAVOURITES).map((favourite) => (
                  <button
                    key={favourite.projectId}
                    type="button"
                    className="kf-place"
                    data-fav=""
                    aria-current={favourite.projectId === routeProjectId ? 'page' : undefined}
                    onClick={() => navigate(`/files?project=${encodeURIComponent(favourite.projectId)}`)}
                  >
                    <StatusShape kind={projectStates[favourite.projectId] ?? 'idle'} />
                    <span className="kf-pname">{favourite.displayName}</span>
                    <span className="kb-m kf-psub">{basename(favourite.path)}</span>
                  </button>
                ))}
                {favourites.length > MAX_FAVOURITES && (
                  <button type="button" className="kf-fav-more kb-lnk" onClick={() => navigate('/projects')}>
                    {`ещё ${favourites.length - MAX_FAVOURITES} в «Все проекты» →`}
                  </button>
                )}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <section className="kf-section" aria-labelledby="kf-h-recent">
              <div className="kf-ruler">
                <span className="kb-m kf-ruler-n" aria-hidden="true">03</span>
                <h2 id="kf-h-recent" className="kb-m kf-ruler-title">НЕДАВНИЕ</h2>
                <span className="kf-ruler-scale" aria-hidden="true" />
              </div>
              <div className="kf-list">
                {recent.map((item) => (
                  <button
                    key={item.entry.path}
                    type="button"
                    className="kf-place"
                    data-recent=""
                    onClick={() => {
                      if (item.projectId && item.projectId !== routeProjectId) {
                        // Another project: re-rooting clears the selection, so open it through the
                        // `?file=` reveal — it unfolds the folders above the file and selects it.
                        navigate(`/files?${new URLSearchParams({ project: item.projectId, file: item.entry.path }).toString()}`);
                        return;
                      }
                      setSelected(item.entry);
                      setIsSheetOpen(true);
                    }}
                  >
                    <span className="kb-m kf-ext-chip" aria-hidden="true">{extensionTag(item.entry.name, false).slice(0, 4)}</span>
                    <span className="kf-place-text">
                      <span className="kf-pname">{item.entry.name}</span>
                      <span className="kb-m kf-psub">{`${item.projectName} · ${formatModified(new Date(item.at).toISOString(), nowMs).replace(/^сегодня /, '')}`}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>

        <main className="kf-tree-col kb-rise kb-d1" aria-labelledby="kf-h-tree">
          <div className="kf-ruler">
            <span className="kb-m kf-ruler-n" aria-hidden="true">04</span>
            <h2 id="kf-h-tree" className="kb-m kf-ruler-title">ДЕРЕВО</h2>
            <span className="kf-ruler-scale" data-major="" aria-hidden="true" />
            <span className="kb-m kf-ruler-meta">папки грузятся по 200</span>
          </div>

          <div className="kf-tools">
            <label htmlFor="files-filter" className="kb-sr">Фильтр по имени</label>
            <div className="kf-filter">
              <FilterGlyph />
              <input
                {...NO_AUTOFILL}
                autoCorrect="off"
                autoCapitalize="off"
                enterKeyHint="search"
                ref={filterRef}
                id="files-filter"
                type="text"
                spellCheck={false}
                value={filter}
                placeholder={`Фильтр по имени в ${rootLabel}`}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && filter) {
                    event.stopPropagation();
                    setFilter('');
                  }
                }}
              />
              <span className="kb-m kf-kbd" aria-hidden="true">/</span>
            </div>
            <button type="button" className="kf-toggle" aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>
              <EyeGlyph />Скрытые
            </button>
            <button
              type="button"
              className="kf-toggle"
              aria-pressed={isSelecting}
              title="Отметить несколько файлов и папок. На компьютере — ещё Ctrl/⌘-клик и правая кнопка мыши"
              onClick={() => (isSelecting ? clearChecked() : setIsSelecting(true))}
            >
              <SelectGlyph />Выбрать
            </button>
          </div>

          {(isSelecting || checked.size > 0) && (
            <div className="kf-selbar kb-fadein" role="toolbar" aria-label="Действия с выбранным">
              <span className="kb-m kf-selbar-count">
                {checkedEntries.length ? `ВЫБРАНО ${checkedEntries.length}` : 'НАЖИМАЙ НА ФАЙЛЫ И ПАПКИ'}
              </span>
              <span style={{ flex: 1 }} />
              {(() => {
                const allEditable = checkedEntries.length > 0 && checkedEntries.every((entry) => canEditPath(entry.path));
                const hint = checkedEntries.length ? editHint : 'Сначала отметь файлы';
                return (
                  <>
                    <Button variant="ghost" size="sm" disabled={!allEditable} title={allEditable ? undefined : hint} onClick={() => setPendingTransfer({ mode: 'copy', entries: checkedEntries })}>
                      <CopyGlyph />Копировать в…
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!allEditable} title={allEditable ? undefined : hint} onClick={() => setPendingTransfer({ mode: 'move', entries: checkedEntries })}>
                      <MoveGlyph />Переместить в…
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!allEditable || isZipping} title={allEditable ? undefined : hint} onClick={() => void downloadZip(checkedEntries)}>
                      <ZipGlyph />{isZipping ? 'Собираю…' : 'Скачать zip'}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!allEditable} title={allEditable ? 'Переносит в ~/.claude/archive — не удаляет' : hint} onClick={() => void archiveMany(checkedEntries)}>
                      <ArchiveGlyph size={14} />В архив
                    </Button>
                  </>
                );
              })()}
              <Button variant="ghost" size="sm" style={{ color: 'var(--kb-soft)' }} onClick={clearChecked}>Готово</Button>
            </div>
          )}

          {isNewFolderOpen && (
            <div className="kf-newfolder kb-fadein" role="group" aria-label={newKind === 'file' ? 'Новый файл' : 'Новая папка'}>
              {newKind === 'file' ? <FilePlusGlyph color="var(--kb-sand)" /> : <FolderGlyph color="var(--kb-sand)" />}
              <label htmlFor="nf-folder" className="kb-m">{`${newKind === 'file' ? 'НОВЫЙ ФАЙЛ' : 'НОВАЯ ПАПКА'} В ${basename(newTarget ?? currentFolder ?? '')}/`}</label>
              <input
                {...NO_AUTOFILL}
                autoCorrect="off"
                autoCapitalize="off"
                enterKeyHint="done"
                id="nf-folder"
                type="text"
                spellCheck={false}
                placeholder={newKind === 'file' ? 'например, заметки.md' : 'например, макеты'}
                value={newFolderName}
                autoFocus
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createFolder();
                  if (event.key === 'Escape') setIsNewFolderOpen(false);
                }}
              />
              <Button variant="pri" onClick={() => void createFolder()}>Создать</Button>
              <Button variant="ghost" style={{ color: 'var(--kb-soft)' }} onClick={() => setIsNewFolderOpen(false)}>Отмена</Button>
            </div>
          )}

          {note && (
            <div className="kf-note kb-fadein" role="status" data-tone={note.kind === 'error' ? 'error' : undefined}>
              {note.kind !== 'error' && <CheckGlyph />}
              {note.kind === 'archived' ? (
                <span className="kf-note-text">
                  <span className="kb-m" style={{ color: 'var(--kb-text)' }}>{note.name}</span> перенесён в <span className="kb-m">~/.claude/archive</span> — не удалён
                </span>
              ) : (
                <span className="kf-note-text" style={note.kind === 'error' ? { color: 'var(--kb-signal-text)' } : undefined}>{note.text}</span>
              )}
              {note.kind === 'archived'
                ? <Button variant="ghost" size="sm" onClick={() => void undoArchive()}>Вернуть</Button>
                : <Button variant="ghost" size="sm" onClick={() => setNote(null)}>Скрыть</Button>}
            </div>
          )}

          {rootPath && (
            <FilesTree
              rootPath={rootPath}
              rootLabel={rootLabel}
              folders={folders}
              expanded={expanded}
              selectedPath={selected?.path ?? null}
              filter={filter}
              showHidden={showHidden}
              changedPaths={git?.changed ?? new Set()}
              nowMs={nowMs}
              onToggleFolder={toggleFolder}
              onSelectFile={selectFile}
              checked={checked}
              isSelecting={isSelecting}
              onCheck={(entry) => {
                setIsSelecting(true);
                toggleChecked(entry);
              }}
              onContextMenu={(entry, x, y) => setRowMenu({ entry, x, y })}
              onLoadMore={(folderPath) => void loadMore(folderPath)}
              onRetry={(folderPath) => void loadFolder(folderPath, true)}
            />
          )}
        </main>

        {!isPhone && (
          <aside className="kf-preview-col kb-rise kb-d2" aria-labelledby="kf-h-preview">
            <div className="kf-ruler">
              <span className="kb-m kf-ruler-n" aria-hidden="true">05</span>
              <h2 id="kf-h-preview" className="kb-m kf-ruler-title">ПРЕВЬЮ</h2>
              <span className="kf-ruler-scale" aria-hidden="true" />
            </div>
            {preview}
          </aside>
        )}
      </div>

      {isPhone && (
        <Sheet
          open={isSheetOpen && Boolean(selected)}
          onClose={() => setIsSheetOpen(false)}
          title="ПРЕВЬЮ"
        >
          <div className="kf-sheet-preview">{preview}</div>
        </Sheet>
      )}

      {pendingUpload && (
        <UploadConflictModal
          // A second refusal (a name taken meanwhile) opens a fresh window with the new free names.
          key={pendingUpload.attempt}
          conflicts={pendingUpload.conflicts}
          uploadNames={pendingUpload.names}
          folderName={basename(pendingUpload.folder)}
          folderNames={[...(folders[pendingUpload.folder]?.entries.map((entry) => entry.name) ?? []), ...(folders[pendingUpload.folder]?.hiddenNames ?? [])]}
          onSubmit={uploadUnderNewNames}
          onCancel={() => setPendingUpload(null)}
        />
      )}

      {download && <DownloadPlate download={download} />}

      {rowMenu && (
        <FilesContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          title={rowMenu.entry.name}
          items={menuItems(rowMenu.entry)}
          onClose={() => setRowMenu(null)}
        />
      )}

      {pendingTransfer && (() => {
        const first = pendingTransfer.entries[0];
        const owner = first ? ownerOf(first.path) : null;
        if (!first || !owner) return null;
        return (
          <TransferModal
            mode={pendingTransfer.mode}
            names={pendingTransfer.entries.map((entry) => entry.name)}
            projects={projects}
            startProjectId={owner.projectId}
            startFolder={parentOf(first.path)}
            pickedFolders={pendingTransfer.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path)}
            onSubmit={transfer}
            onCancel={() => setPendingTransfer(null)}
          />
        );
      })()}

      {isDragging && (
        <div className="kf-drop kb-fadein" aria-hidden="true">
          <div className="kf-drop-card">
            <UploadGlyph size={28} color="var(--kb-signal)" />
            <span className="kf-drop-title">{writable ? `Отпусти — загружу в ${basename(currentFolder ?? '')}/` : 'Сюда загрузить нельзя'}</span>
            <span className="kb-m kf-hint">{writable ? 'до 20 файлов, каждый до 200 МБ' : writeHint}</span>
          </div>
        </div>
      )}
    </div>
  );
}

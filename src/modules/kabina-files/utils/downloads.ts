/**
 * Downloads with progress for «Файлы»: the screen and the preview read the answer
 * chunk by chunk so the download plate can show «45 % · 12 из 27 МБ», and the user
 * can cancel. Used by FilesScreen (file, zip) and FilePreview («Скачать»).
 */

/** One download in flight, as the plate draws it. `total` is null when the size is unknown. */
export type DownloadProgress = {
  name: string;
  /** `preparing` — the server is still building a zip; `loading` — bytes are arriving. */
  phase: 'preparing' | 'loading';
  loaded: number;
  total: number | null;
  cancel: () => void;
};

/** How often the plate is redrawn while bytes arrive (ms). */
const REDRAW_MS = 120;

/**
 * The size to expect: the answer's Content-Length when the body is not re-encoded on the
 * way (a compressed answer counts other bytes), else `sizeHint` (the tree's own size).
 */
export function expectedSize(response: Response, sizeHint: number | null): number | null {
  const length = Number(response.headers.get('Content-Length'));
  const encoded = Boolean(response.headers.get('Content-Encoding'));
  if (!encoded && Number.isFinite(length) && length > 0) return length;
  return sizeHint && sizeHint > 0 ? sizeHint : null;
}

/** Reads the body into a Blob, reporting `loaded` bytes at most every REDRAW_MS and once at the end. */
export async function readWithProgress(
  response: Response,
  total: number | null,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Blob> {
  const type = response.headers.get('Content-Type') ?? '';
  // No readable stream (old browsers, test doubles): one step from nothing to done.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob();
    onProgress(blob.size, total ?? blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  let drawnAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = Date.now();
    if (now - drawnAt >= REDRAW_MS) {
      drawnAt = now;
      onProgress(loaded, total);
    }
  }
  onProgress(loaded, total ?? loaded);
  return new Blob(chunks, { type });
}

/** Saves a blob under `name` through a temporary link (the browser's own download). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A cancelled download (the user pressed «Отмена»), told apart from a failed one. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string })?.name === 'AbortError';
}

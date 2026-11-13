import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPageNumber } from '@/modules/kabina-files/kabina-files.routes.js';
import { createKabinaFilesService } from '@/modules/kabina-files/kabina-files.service.js';
import { AppError } from '@/shared/utils.js';

async function withWorkspace(run: (context: { root: string; project: string; archive: string; outside: string }) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), 'kabina-files-'));
  const root = path.join(base, 'workspace');
  const project = path.join(root, 'demo-site');
  const archive = path.join(base, 'archive');
  const outside = path.join(base, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside);
  try {
    await run({ root, project, archive, outside });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function serviceFor(root: string, project: string, archive: string, other: string | null = null) {
  return createKabinaFilesService({
    workspaceRoot: root,
    archiveRoot: archive,
    getProjectPathById: (projectId) => (projectId === 'p1' ? project : projectId === 'p2' ? other : null),
    now: () => new Date('2026-10-26T09:00:00Z'),
  });
}

test('a folder page lists folders first, counts everything and pages without a silent cut', async () => {
  await withWorkspace(async ({ root, project, archive }) => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'a.md'), '# A');
    await writeFile(path.join(project, '.env'), 'SECRET=1');
    await mkdir(path.join(project, 'node_modules'));
    for (let index = 0; index < 450; index += 1) {
      await writeFile(path.join(project, 'node_modules', `pkg-${String(index).padStart(3, '0')}.js`), '');
    }
    await writeFile(path.join(project, 'README.md'), 'hello');
    const service = serviceFor(root, project, archive);

    const top = await service.listFolder({ path: project });
    assert.deepEqual(top.entries.map((entry) => entry.name), ['docs', 'node_modules', 'README.md']);
    assert.equal(top.total, 3);
    assert.equal(top.hiddenCount, 1);
    assert.deepEqual(top.hiddenNames, ['.env']);
    assert.equal(top.entries[1].childCount, 450);
    assert.equal(top.entries[2].size, 5);

    const withHidden = await service.listFolder({ path: project, showHidden: true });
    assert.equal(withHidden.total, 4);

    const first = await service.listFolder({ path: path.join(project, 'node_modules'), limit: 200 });
    const third = await service.listFolder({ path: path.join(project, 'node_modules'), offset: 400, limit: 200 });
    assert.equal(first.entries.length, 200);
    assert.equal(first.total, 450);
    assert.equal(third.entries.length, 50, 'the last page holds the rest');
  });
});

test('folders outside the workspace root are refused, also through a symlink', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await symlink(outside, path.join(project, 'escape'));
    const service = serviceFor(root, project, archive);
    await assert.rejects(service.listFolder({ path: outside }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(service.listFolder({ path: path.join(project, 'escape') }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    const rootPage = await service.listFolder({ path: root });
    assert.equal(rootPage.parent, null, 'the workspace root has no way up');
    // `~` is the workspace root, whatever its path on this server.
    const tildePage = await service.listFolder({ path: '~', limit: 1 });
    assert.equal(tildePage.path, rootPage.path);
    assert.equal(tildePage.places.root, rootPage.places.root);
  });
});

test('«В архив» moves into the archive and «Вернуть» puts it back; nothing outside the project is touched', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'ТЗ.md'), 'ТЗ');
    await writeFile(path.join(outside, 'x.txt'), 'x');
    const service = serviceFor(root, project, archive);

    const archived = await service.archiveEntry({ projectId: 'p1', path: 'docs/ТЗ.md' });
    assert.equal(archived.archivedPath, path.join(archive, 'files', '2026-10-26', 'demo-site', 'docs', 'ТЗ.md'));
    assert.equal(await readFile(archived.archivedPath, 'utf8'), 'ТЗ');
    await assert.rejects(readFile(path.join(project, 'docs', 'ТЗ.md')));

    // A second archive of the same name the same day does not overwrite the first.
    await writeFile(path.join(project, 'docs', 'ТЗ.md'), 'ТЗ v2');
    const second = await service.archiveEntry({ projectId: 'p1', path: path.join(project, 'docs', 'ТЗ.md') });
    assert.ok(second.archivedPath.endsWith('ТЗ (2).md'));

    const restored = await service.restoreEntry({ projectId: 'p1', archivedPath: archived.archivedPath, originalPath: archived.originalPath });
    assert.equal(await readFile(restored.restoredPath, 'utf8'), 'ТЗ');

    await assert.rejects(service.archiveEntry({ projectId: 'p1', path: '../../outside/x.txt' }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(service.archiveEntry({ projectId: 'p1', path: '.' }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(
      service.restoreEntry({ projectId: 'p1', archivedPath: path.join(outside, 'x.txt'), originalPath: path.join(project, 'x.txt') }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    await assert.rejects(service.archiveEntry({ projectId: 'nope', path: 'docs' }), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});

test('«Вернуть» does not write through a symlinked folder to outside the project', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await writeFile(path.join(project, 'note.md'), 'заметка');
    await symlink(outside, path.join(project, 'escape'));
    const service = serviceFor(root, project, archive);
    const archived = await service.archiveEntry({ projectId: 'p1', path: 'note.md' });

    for (const originalPath of [
      path.join(project, 'escape', 'note.md'),
      // A folder that does not exist under the link — it would be created outside.
      path.join(project, 'escape', 'new-folder', 'note.md'),
    ]) {
      await assert.rejects(
        service.restoreEntry({ projectId: 'p1', archivedPath: archived.archivedPath, originalPath }),
        (error: unknown) => error instanceof AppError && error.statusCode === 403,
      );
    }
    await assert.rejects(readFile(path.join(outside, 'note.md')));
    assert.equal(await readFile(archived.archivedPath, 'utf8'), 'заметка');

    // A folder that is gone is recreated inside the project.
    const restored = await service.restoreEntry({
      projectId: 'p1',
      archivedPath: archived.archivedPath,
      originalPath: path.join(project, 'gone', 'note.md'),
    });
    assert.equal(restored.restoredPath, path.join(project, 'gone', 'note.md'));
    assert.equal(await readFile(restored.restoredPath, 'utf8'), 'заметка');
  });
});

test('«Вернуть» does not pull a file out through a link that was archived (review fix Н-9)', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await writeFile(path.join(outside, 'secret.txt'), 'чужой файл');
    await symlink(outside, path.join(project, 'link'));
    const service = serviceFor(root, project, archive);
    // The link itself goes to the archive, still pointing outside.
    const archived = await service.archiveEntry({ projectId: 'p1', path: 'link' });

    await assert.rejects(
      service.restoreEntry({
        projectId: 'p1',
        archivedPath: path.join(archived.archivedPath, 'secret.txt'),
        originalPath: path.join(project, 'pulled.txt'),
      }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'чужой файл');
    await assert.rejects(readFile(path.join(project, 'pulled.txt')));

    // The archived link itself can still come back as a link.
    const restored = await service.restoreEntry({ projectId: 'p1', archivedPath: archived.archivedPath, originalPath: path.join(project, 'link') });
    assert.equal(restored.restoredPath, path.join(project, 'link'));
    assert.equal(await readFile(path.join(project, 'link', 'secret.txt'), 'utf8'), 'чужой файл');
  });
});

test('page numbers in the query must be non-negative integers', () => {
  assert.equal(readPageNumber(undefined, 'offset'), undefined);
  assert.equal(readPageNumber('200', 'offset'), 200);
  assert.throws(() => readPageNumber('-1', 'offset'));
  assert.throws(() => readPageNumber('abc', 'limit'));
});

test('copy keeps the original and never overwrites; move carries a folder to another project', async () => {
  await withWorkspace(async ({ root, project, archive }) => {
    const other = path.join(root, 'blog');
    await mkdir(path.join(other, 'drafts'), { recursive: true });
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'a.md'), '# A');
    await writeFile(path.join(project, 'readme.md'), 'R');
    const service = serviceFor(root, project, archive, other);

    // Copy into the same folder: a second file, « (2)», the first untouched.
    const copied = await service.transferEntries({ projectId: 'p1', paths: ['readme.md'], toProjectId: 'p1', toFolder: project, mode: 'copy' });
    assert.equal(copied.items[0].to, path.join(project, 'readme (2).md'));
    assert.equal(await readFile(path.join(project, 'readme.md'), 'utf8'), 'R');

    // A folder and a file inside it picked together: the folder carries the file once.
    const moved = await service.transferEntries({
      projectId: 'p1', paths: [path.join(project, 'docs'), path.join(project, 'docs', 'a.md')], toProjectId: 'p2', toFolder: 'drafts', mode: 'move',
    });
    assert.equal(moved.items.length, 1);
    assert.equal(await readFile(path.join(other, 'drafts', 'docs', 'a.md'), 'utf8'), '# A');
    await assert.rejects(readFile(path.join(project, 'docs', 'a.md')));
  });
});

test('nothing lands in itself or outside a project', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await mkdir(path.join(project, 'docs', 'deep'), { recursive: true });
    await symlink(outside, path.join(project, 'out'));
    const service = serviceFor(root, project, archive);
    await assert.rejects(
      service.transferEntries({ projectId: 'p1', paths: ['docs'], toProjectId: 'p1', toFolder: 'docs/deep', mode: 'move' }),
      (error: unknown) => error instanceof AppError && error.code === 'KABINA_FILES_INTO_ITSELF',
    );
    // A link inside the project that points outside is not a way out.
    await assert.rejects(
      service.transferEntries({ projectId: 'p1', paths: ['docs'], toProjectId: 'p1', toFolder: 'out', mode: 'copy' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    await assert.rejects(
      service.transferEntries({ projectId: 'p1', paths: [], toProjectId: 'p1', toFolder: project, mode: 'copy' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  });
});

test('a zip packs folders and files but leaves out links and secrets', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await mkdir(path.join(project, 'docs', '.ssh'), { recursive: true });
    await writeFile(path.join(project, 'docs', 'a.md'), '# A');
    await writeFile(path.join(project, 'docs', '.env'), 'SECRET=1');
    await writeFile(path.join(project, 'docs', '.ssh', 'id_ed25519'), 'KEY');
    await writeFile(path.join(outside, 'secret.txt'), 'чужой');
    await symlink(outside, path.join(project, 'docs', 'out'));
    const service = serviceFor(root, project, archive);

    const { fileName, skipped, zip } = await service.zipEntries({ projectId: 'p1', paths: ['docs'] });
    assert.equal(fileName, 'docs.zip');
    const names = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
    assert.deepEqual(names, ['docs/a.md']);
    assert.equal(await zip.file('docs/a.md')?.async('string'), '# A');
    assert.equal(skipped, 3, '.env, .ssh and the link');
  });
});

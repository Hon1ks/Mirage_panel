// fileTreeRoutes: used by the server entrypoint to mount the complete authenticated File Tree API at `/api/file-tree`.
export { fileTreeRoutes } from '@/modules/file-tree/file-tree.module.js';
// isPrivateWorkspacePath: used by kabina-files so a zip download never packs keys, credentials or the panel database (Н-7).
export { isPrivateWorkspacePath } from '@/modules/file-tree/file-tree.service.js';

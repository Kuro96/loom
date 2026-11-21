import { unwrapResult } from './state.mjs';

export function readWorkspaceFile(files, renderOffice) {
  return async ({ sessionId, path }, range, signal) => unwrapResult(range === 'bytes'
    ? await files.readBytes(sessionId, path, {}, signal)
    : range === 'office' ? await renderOffice(sessionId, path, signal)
    : await files.read(sessionId, path, range, signal));
}

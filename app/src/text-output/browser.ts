import type { DirectoryHandle, TextRuntime } from './ports.ts';
import { TextFileError } from './ports.ts';

function picker() {
  return (
    globalThis as unknown as {
      showDirectoryPicker?: (options: {
        mode: 'readwrite';
        id: string;
      }) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;
}
function safePath(path: readonly string[]) {
  if (!path.length || path.some((p) => !p || p === '.' || p === '..' || /[\\/:\x00-\x1f]/.test(p)))
    throw new TextFileError('HANDLE_INVALID', '文件路径无效，未写入');
}
async function parent(root: DirectoryHandle, path: readonly string[], create: boolean) {
  safePath(path);
  let dir = root;
  for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}
/** Native FSA only. No filesystem observers, rename, delete, or reverse imports. */
export function createBrowserTextRuntime(): TextRuntime {
  return {
    supported: () =>
      typeof picker() === 'function' &&
      typeof navigator !== 'undefined' &&
      !!navigator.locks &&
      globalThis.isSecureContext === true,
    pickDirectory: () => {
      const pick = picker();
      if (!pick)
        throw new TextFileError('UNSUPPORTED', '此浏览器不支持目录自动写入，可手动下载文本');
      return pick({ mode: 'readwrite', id: 'cardgrid-text-output' });
    },
    async permission(handle, request) {
      const status = await handle.queryPermission({ mode: 'readwrite' });
      return status === 'granted' || !request
        ? status
        : handle.requestPermission({ mode: 'readwrite' });
    },
    async read(handle, path) {
      try {
        const dir = await parent(handle, path, false),
          file = await dir.getFileHandle(path.at(-1)!);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch (e) {
        if ((e as { name?: string })?.name === 'NotFoundError') return null;
        throw e;
      }
    },
    async write(handle, path, bytes, beforeOpen) {
      await beforeOpen();
      const dir = await parent(handle, path, true),
        file = await dir.getFileHandle(path.at(-1)!, { create: true });
      await beforeOpen();
      const stream = await file.createWritable();
      try {
        await stream.write(new Uint8Array(bytes));
        await stream.close();
      } catch (e) {
        try {
          await stream.abort();
        } catch {}
        throw e;
      }
    },
    async lock<T>(bindingId: string, work: () => Promise<T>): Promise<T> {
      if (typeof navigator === 'undefined' || !navigator.locks)
        throw new TextFileError('UNSUPPORTED', '缺少跨窗口写锁，自动写入已暂停');
      return (await navigator.locks.request(
        `CardGrid:text-output:${bindingId}`,
        { mode: 'exclusive' },
        async () => await work(),
      )) as T;
    },
  };
}

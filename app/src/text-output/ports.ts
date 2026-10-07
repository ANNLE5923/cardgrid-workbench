import type {
  FileResult,
  OutputKey,
  TextOutputState,
  TextWriteIntent,
  TextSyncStatus,
} from '../workspace/v06.ts';
import type { TextDocument } from './model.ts';

/** A private browser capability. It never appears in a UI DTO or business backup. */
export interface DirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    createWritable(): Promise<{
      write(bytes: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
}
export interface TextRuntime {
  supported(): boolean;
  pickDirectory(): Promise<DirectoryHandle>;
  permission(handle: DirectoryHandle, request: boolean): Promise<PermissionState>;
  read(handle: DirectoryHandle, path: readonly string[]): Promise<Uint8Array | null>;
  write(
    handle: DirectoryHandle,
    path: readonly string[],
    bytes: Uint8Array,
    beforeOpen: () => Promise<void>,
  ): Promise<void>;
  lock<T>(bindingId: string, work: () => Promise<T>): Promise<T>;
}
export type OutputDate = Readonly<{ kind: OutputKey['kind']; date: string; zone: string }>;
export interface TextSourceProvider {
  context(): Promise<{ epoch: string; zone: string; revision: number; v5: boolean }>;
  dates(): Promise<readonly OutputDate[]>;
  render(key: OutputKey): Promise<TextDocument>;
  subscribe(listener: () => void): () => void;
  event?(input: {
    epoch: string;
    operation: string;
    stage: 'requested' | 'succeeded' | 'failed';
    key?: OutputKey;
    bindingId: string;
    connectionVersion: number;
    errorCode?: string;
  }): Promise<void>;
}
export interface TextRepository {
  read(key: string): Promise<unknown>;
  keys(prefix?: string): Promise<readonly string[]>;
  atomic<T>(
    keys: readonly string[],
    reduce: (
      values: readonly unknown[],
      workspace: unknown,
    ) => { result: T; writes?: readonly { key: string; value: unknown }[] },
  ): Promise<T>;
}
export type FileBinding = Readonly<{
  schemaVersion: 1;
  bindingId: string;
  connectionVersion: number;
  epoch: string;
  suffix: 'md' | 'txt';
  handle: DirectoryHandle;
  enabled: boolean;
  status: TextSyncStatus;
}>;
export type OutputRecord = TextOutputState &
  Readonly<{ schemaVersion: 1; revision: number; dirty: boolean; intent: TextWriteIntent | null }>;
export class TextFileError extends Error {
  readonly code: Extract<FileResult<never>, { ok: false }>['code'];
  constructor(code: Extract<FileResult<never>, { ok: false }>['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'TextFileError';
  }
}
export function fileFailure(error: unknown): Extract<FileResult<never>, { ok: false }> {
  const code =
    error instanceof TextFileError
      ? error.code
      : (error as { name?: string })?.name === 'NotAllowedError'
        ? 'PERMISSION_REQUIRED'
        : (error as { name?: string })?.name === 'NotFoundError'
          ? 'HANDLE_INVALID'
          : 'IO_FAILED';
  return {
    ok: false,
    code,
    message: error instanceof Error ? error.message : '文件操作失败，主数据仍已保存',
    retry:
      code === 'UNSUPPORTED'
        ? 'none'
        : code === 'PERMISSION_REQUIRED' ||
            code === 'HANDLE_INVALID' ||
            code === 'WORKSPACE_REPLACED'
          ? 'reconnect'
          : code === 'SOURCE_STALE'
            ? 'refresh'
            : 'retry-file',
  };
}

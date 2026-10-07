import {
  emptyData,
  readEnvelope,
  migrateV1,
  validateData,
  type Data,
  type Envelope,
} from './legacy/domain.ts';
const DB = 'cardgrid-workspace';
export type Recovery = { createdAt: string; reason: string; raw: unknown };
let connection: IDBDatabase | null = null;
export async function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 5);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of ['workspace', 'recovery', 'maintenance', 'text-output', 'monthly-archive'])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    r.onerror = () =>
      reject(new Error('无法打开本地数据；未覆盖原记录。' + (r.error?.message || '')));
    r.onblocked = () => reject(new Error('其他窗口仍在使用旧数据，请关闭其他CardGrid窗口后重试。'));
    r.onsuccess = () => {
      connection = r.result;
      connection.onversionchange = () => {
        connection?.close();
        connection = null;
      };
      resolve(connection);
    };
  });
}
async function get(store: string, key: string): Promise<unknown> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function load(): Promise<Envelope> {
  const raw = await get('workspace', 'current');
  return raw === undefined
    ? { schemaVersion: 3, revision: 0, data: emptyData() }
    : readEnvelope(raw);
}
export async function rawData() {
  return get('workspace', 'current');
}
export async function recovery(): Promise<Recovery | undefined> {
  return (await get('recovery', 'previous')) as Recovery | undefined;
}
export async function migrationBackup() {
  return get('recovery', 'pre-p1a');
}
/** Retired P1A write entry. Production callers must submit a versioned Host command. */
export async function commit(
  _data: Data,
  _expected: number,
  _reason: string,
  _reset = false,
): Promise<Envelope> {
  throw new Error('旧版整份保存入口已关闭；请通过 workspace-client 提交命令。');
}
const channel: BroadcastChannel | null = null; // Old subscriptions cannot drive production state.
function notify() {
  channel?.postMessage('changed');
}
export function onExternalChange(fn: () => void) {
  if (!channel) return () => {};
  channel.addEventListener('message', fn);
  return () => channel.removeEventListener('message', fn);
}
export async function exportRecovery(): Promise<Data> {
  const r = await recovery();
  if (!r) throw Error('还没有本机恢复点');
  const raw = r.raw as { schemaVersion?: number };
  return (raw.schemaVersion === 1 ? migrateV1(raw) : readEnvelope(raw)).data;
}

/** New storage boundary. No business migration/bootstrap runs while opening or reading. */
export type AtomicChange<T> = Readonly<{
  result: T;
  write?: unknown;
  clearRecovery?: boolean;
  reason?: string;
  at?: string;
}>;
export interface WorkspaceStore {
  read(): Promise<unknown>;
  readRecovery(): Promise<readonly Readonly<{ key: IDBValidKey; value: unknown }>[]>;
  atomic<T>(reduce: (raw: unknown) => AtomicChange<T>): Promise<T>;
  subscribe(listener: (external: boolean) => void): () => void;
  readMaintenance?(key: string): Promise<unknown>;
  atomicMaintenance?<T>(
    key: string,
    reduce: (raw: unknown) => { write?: unknown; result: T },
  ): Promise<T>;
  listMaintenanceKeys?(): Promise<readonly string[]>;
  readTextOutput?(key: string): Promise<unknown>;
  listTextOutputKeys?(prefix?: string): Promise<readonly string[]>;
  atomicTextOutput?<T>(
    keys: readonly string[],
    reduce: (
      values: readonly unknown[],
      workspace: unknown,
    ) => { result: T; writes?: readonly { key: string; value: unknown }[] },
  ): Promise<T>;
  readMonthlyArchive?(key: string): Promise<unknown>;
  listMonthlyArchiveIndex?(): Promise<readonly unknown[]>;
  atomicMonthlyArchive?<T>(
    keys: readonly string[],
    reduce: (
      values: readonly unknown[],
      workspace: unknown,
    ) => AtomicChange<T> & { archiveWrites?: readonly { key: string; value: unknown }[] },
  ): Promise<T>;
  close(): void;
}
export function createWorkspaceStore(
  options: { name?: string; factory?: IDBFactory } = {},
): WorkspaceStore {
  const name = options.name ?? DB;
  let opening: Promise<IDBDatabase> | undefined;
  let closed = false;
  const listeners = new Set<(external: boolean) => void>();
  const bus = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${name}:v4`);
  const emit = (external: boolean = false) => {
    for (const listener of listeners) {
      try {
        listener(external);
      } catch {
        /* notification cannot turn a committed write into failure */
      }
    }
  };
  if (bus) bus.onmessage = () => emit(true);
  const focus = () => emit(true);
  if (typeof window !== 'undefined') window.addEventListener('focus', focus);
  function open(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(new Error('工作区连接已关闭'));
    if (!opening)
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = (options.factory ?? indexedDB).open(name, 5);
        let abandoned = false;
        request.onupgradeneeded = () => {
          // Storage slots only: opening the DB never migrates business JSON.
          for (const storeName of [
            'workspace',
            'recovery',
            'maintenance',
            'text-output',
            'monthly-archive',
          ])
            if (!request.result.objectStoreNames.contains(storeName))
              request.result.createObjectStore(storeName);
        };
        request.onblocked = () => {
          abandoned = true;
          reject(new Error('其他窗口仍占用旧数据库，请关闭后重试'));
        };
        request.onerror = () => reject(request.error ?? new Error('无法打开本地数据'));
        request.onsuccess = () => {
          const db = request.result;
          if (closed || abandoned) {
            db.close();
            if (closed) reject(new Error('工作区连接已关闭'));
            return;
          }
          db.onversionchange = () => {
            db.close();
            opening = undefined;
            emit();
          };
          resolve(db);
        };
      }).catch((error) => {
        opening = undefined;
        throw error;
      });
    return opening;
  }
  return {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('workspace', 'readonly');
        const request = tx.objectStore('workspace').get('current');
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error ?? new Error('读取失败'));
        tx.onerror = () => {};
      });
    },
    async readRecovery() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('recovery', 'readonly'),
          store = tx.objectStore('recovery');
        const keys = store.getAllKeys(),
          values = store.getAll();
        tx.oncomplete = () =>
          resolve(keys.result.map((key, i) => ({ key, value: values.result[i] })));
        tx.onabort = () => reject(tx.error ?? new Error('恢复点读取失败'));
        tx.onerror = () => {};
      });
    },
    async atomic<T>(reduce: (raw: unknown) => AtomicChange<T>): Promise<T> {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(['workspace', 'recovery'], 'readwrite');
        const store = tx.objectStore('workspace'),
          request = store.get('current');
        let change: AtomicChange<T> | undefined, failure: unknown;
        request.onsuccess = () => {
          try {
            change = reduce(request.result);
            if (change && typeof (change as unknown as { then?: unknown }).then === 'function')
              throw new Error('事务回调必须同步执行');
            if (Object.hasOwn(change, 'write')) {
              if (change.write === undefined) throw new Error('工作区写入不能为空');
              if (change.clearRecovery) tx.objectStore('recovery').clear();
              else if (request.result !== undefined)
                tx.objectStore('recovery').put(
                  { raw: request.result, reason: change.reason ?? '', createdAt: change.at ?? '' },
                  'previous',
                );
              store.put(change.write, 'current');
            }
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          if (change && Object.hasOwn(change, 'write')) {
            emit(false);
            try {
              bus?.postMessage('changed');
            } catch {}
          }
          resolve(change!.result);
        };
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('保存失败，原记录已保留'));
        tx.onerror = () => {};
      });
    },
    async readMaintenance(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('maintenance', 'readonly'),
          r = tx.objectStore('maintenance').get(key);
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error ?? new Error('日志读取失败'));
      });
    },
    async atomicMaintenance<T>(
      key: string,
      reduce: (raw: unknown) => { write?: unknown; result: T },
    ) {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction('maintenance', 'readwrite'),
          st = tx.objectStore('maintenance'),
          r = st.get(key);
        let change: { write?: unknown; result: T } | undefined, failure: unknown;
        r.onsuccess = () => {
          try {
            change = reduce(r.result);
            if (Object.hasOwn(change, 'write')) st.put(change.write, key);
          } catch (e) {
            failure = e;
            try {
              tx.abort();
            } catch {}
          }
        };
        tx.oncomplete = () => resolve(change!.result);
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('日志保存失败'));
        tx.onerror = () => {};
      });
    },
    async listMaintenanceKeys() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('maintenance'),
          r = tx.objectStore('maintenance').getAllKeys();
        tx.oncomplete = () => resolve(r.result.filter((k): k is string => typeof k === 'string'));
        tx.onabort = () => reject(tx.error ?? new Error('日志索引读取失败'));
      });
    },
    async readTextOutput(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('text-output'),
          r = tx.objectStore('text-output').get(key);
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error ?? new Error('文件状态读取失败'));
      });
    },
    async listTextOutputKeys(prefix) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('text-output'),
          r = tx
            .objectStore('text-output')
            .getAllKeys(prefix ? IDBKeyRange.bound(prefix, prefix + '\uffff') : undefined);
        tx.oncomplete = () => resolve(r.result.filter((k): k is string => typeof k === 'string'));
        tx.onabort = () => reject(tx.error ?? new Error('文件索引读取失败'));
      });
    },
    async atomicTextOutput<T>(
      keys: readonly string[],
      reduce: (
        values: readonly unknown[],
        workspace: unknown,
      ) => { result: T; writes?: readonly { key: string; value: unknown }[] },
    ) {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(['workspace', 'text-output'], 'readwrite'),
          st = tx.objectStore('text-output'),
          requests = keys.map((key) => st.get(key)),
          current = tx.objectStore('workspace').get('current');
        let remaining = requests.length + 1,
          change: ReturnType<typeof reduce> | undefined,
          failure: unknown;
        const received = () => {
          if (--remaining) return;
          try {
            change = reduce(
              requests.map((r) => r.result),
              current.result,
            );
            if (change && typeof (change as unknown as { then?: unknown }).then === 'function')
              throw new Error('文件状态事务回调必须同步');
            for (const write of change.writes ?? []) {
              if (write.value === undefined) throw new Error('文件状态不可为空');
              st.put(write.value, write.key);
            }
          } catch (e) {
            failure = e;
            try {
              tx.abort();
            } catch {}
          }
        };
        for (const r of [...requests, current]) r.onsuccess = received;
        tx.oncomplete = () => resolve(change!.result);
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('文件状态保存失败，业务未改动'));
        tx.onerror = () => {};
      });
    },
    async readMonthlyArchive(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('monthly-archive'),
          r = tx.objectStore('monthly-archive').get(key);
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error ?? new Error('归档读取失败'));
      });
    },
    async listMonthlyArchiveIndex() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('monthly-archive'),
          r = tx.objectStore('monthly-archive').getAll(IDBKeyRange.bound('index:', 'index:\uffff'));
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error ?? new Error('归档索引读取失败'));
      });
    },
    async atomicMonthlyArchive<T>(
      keys: readonly string[],
      reduce: (
        values: readonly unknown[],
        workspace: unknown,
      ) => AtomicChange<T> & { archiveWrites?: readonly { key: string; value: unknown }[] },
    ) {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(['workspace', 'recovery', 'monthly-archive'], 'readwrite'),
          st = tx.objectStore('monthly-archive'),
          requests = keys.map((k) => st.get(k)),
          current = tx.objectStore('workspace').get('current');
        let remaining = requests.length + 1,
          change: ReturnType<typeof reduce> | undefined,
          failure: unknown;
        const received = () => {
          if (--remaining) return;
          try {
            change = reduce(
              requests.map((r) => r.result),
              current.result,
            );
            if (change && typeof (change as any).then === 'function')
              throw Error('归档事务回调必须同步');
            if (Object.hasOwn(change, 'write')) {
              if (change.write === undefined) throw Error('归档工作区写入不可为空');
              if (current.result !== undefined)
                tx.objectStore('recovery').put(
                  { raw: current.result, reason: change.reason ?? '', createdAt: change.at ?? '' },
                  'previous',
                );
              tx.objectStore('workspace').put(change.write, 'current');
            }
            for (const w of change.archiveWrites ?? []) {
              if (w.value === undefined) throw Error('归档字节不可为空');
              st.put(w.value, w.key);
            }
          } catch (e) {
            failure = e;
            try {
              tx.abort();
            } catch {}
          }
        };
        for (const r of [...requests, current]) r.onsuccess = received;
        tx.oncomplete = () => {
          if (change && (Object.hasOwn(change, 'write') || change.archiveWrites?.length)) {
            emit(false);
            try {
              bus?.postMessage('changed');
            } catch {}
          }
          resolve(change!.result);
        };
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('归档事务失败，活动记录保留'));
        tx.onerror = () => {};
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      void opening?.then((db) => db.close()).catch(() => {});
      bus?.close();
      listeners.clear();
      if (typeof window !== 'undefined') window.removeEventListener('focus', focus);
    },
  };
}

// Test-only harness for v0.6.5 P0-A Data v5 只读安全打开面（NOT part of the product bundle）。
// 在默认数据库 cardgrid-workspace 上造一份合法 v5，再直接改坏 workspace/current，
// 然后挂载真实 <RootApp/>，验证损坏后进入只读安全面、可导出原文/恢复点、无编辑入口、
// 外部修复后“重试正常打开”能回到 Today。
//
//   /__v06safeopen
//
import { createRoot } from 'react-dom/client';
import { installB4 } from './v06-b4-harness.ts';
import { RootApp } from '../../src/app/RootApp.tsx';

const DB_NAME = 'cardgrid-workspace';
let cg: any = null;
let root: ReturnType<typeof createRoot> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function evidence() {
  const db = await openDb();
  try {
    const tx = db.transaction(['workspace', 'recovery'], 'readonly');
    const cur = await asPromise<any>(tx.objectStore('workspace').get('current') as IDBRequest<any>);
    const recoveryKeys = (
      await asPromise<IDBValidKey[]>(
        tx.objectStore('recovery').getAllKeys() as IDBRequest<IDBValidKey[]>,
      )
    ).slice();
    await txDone(tx);
    return {
      revision: cur?.revision ?? null,
      dataFormat: cur?.dataFormat ?? null,
      recoveryKeys: recoveryKeys.map(String).sort(),
    };
  } finally {
    db.close();
  }
}

async function corrupt(kind: 'unknown' | 'nested' | 'missing' = 'unknown') {
  const db = await openDb();
  try {
    const tx = db.transaction('workspace', 'readwrite');
    const store = tx.objectStore('workspace');
    const cur = await asPromise<any>(store.get('current') as IDBRequest<any>);
    if (kind === 'missing') delete cur.data.workspaceId;
    else if (kind === 'nested') cur.data.actionCards[0].nestedTamper = true;
    else cur.data.rootTamper = true;
    await asPromise(store.put(cur, 'current') as IDBRequest<IDBValidKey>);
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function repair() {
  const db = await openDb();
  try {
    const tx = db.transaction(['recovery', 'workspace'], 'readwrite');
    const point = await asPromise<any>(
      tx.objectStore('recovery').get('previous') as IDBRequest<any>,
    );
    await asPromise(
      tx.objectStore('workspace').put(point.raw, 'current') as IDBRequest<IDBValidKey>,
    );
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function install() {
  // undefined → 使用与真实 RootApp 相同的默认数据库名。
  cg = installB4(undefined as unknown as string);
  await cg.setup();
  return evidence();
}
function mount() {
  if (root) return;
  root = createRoot(document.getElementById('root')!);
  root.render(<RootApp />);
}
function unmount() {
  root?.unmount();
  root = null;
}

(window as unknown as { __safeopen: unknown }).__safeopen = {
  install,
  corrupt,
  repair,
  evidence,
  mount,
  unmount,
};

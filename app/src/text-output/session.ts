import type {
  FileResult,
  OutputKey,
  TextConnectionView,
  TextFilePort,
  TextOutputState,
  TextSourceVersion,
} from '../workspace/v06.ts';
import { canonicalJson } from '../workspace/codec.ts';
import { assertDate, assertZone } from '../daily/time.ts';
import { hashTextBytes, planTextReconciliation, type TextDocument } from './model.ts';
import { createBrowserTextRuntime } from './browser.ts';
import {
  fileFailure,
  TextFileError,
  type FileBinding,
  type OutputRecord,
  type TextRepository,
  type TextRuntime,
  type TextSourceProvider,
  type OutputDate,
} from './ports.ts';

const ACTIVE = 'text:active',
  bindingKey = (id: string) => `text:binding:${id}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const bytes = (text: string) => new TextEncoder().encode(text);
/** Escaping UTF-16 units is injective, including lone surrogates. No slash/dot/device escape. */
const segment = (value: string) =>
  value
    .replace(/[^A-Za-z0-9_-]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '%$1');
export const outputStorageKey = (key: OutputKey) =>
  JSON.stringify([
    'text-output',
    key.bindingId,
    key.connectionVersion,
    key.epoch,
    key.kind,
    key.date,
    key.zone,
  ]);
const outputPrefix = (b: FileBinding) =>
  JSON.stringify(['text-output', b.bindingId, b.connectionVersion, b.epoch]).slice(0, -1) + ',';
export function outputPath(key: OutputKey, suffix: 'md' | 'txt'): readonly string[] {
  assertDate(key.date);
  assertZone(key.zone);
  return [
    'CardGrid',
    segment(key.bindingId),
    segment(key.epoch),
    key.kind,
    segment(key.zone),
    `${key.date}.${suffix}`,
  ];
}
const decodeKey = (key: string): OutputKey => {
  const p = JSON.parse(key);
  if (!Array.isArray(p) || p.length !== 7 || p[0] !== 'text-output')
    throw new TextFileError('HANDLE_INVALID', '文件索引无效，未覆盖原文件');
  return {
    bindingId: p[1],
    connectionVersion: p[2],
    epoch: p[3],
    kind: p[4],
    date: p[5],
    zone: p[6],
  };
};
function binding(raw: unknown): FileBinding {
  const b = raw as FileBinding;
  if (
    !b ||
    b.schemaVersion !== 1 ||
    !b.bindingId ||
    !Number.isSafeInteger(b.connectionVersion) ||
    b.connectionVersion < 1 ||
    !b.epoch ||
    !['md', 'txt'].includes(b.suffix) ||
    b.handle?.kind !== 'directory' ||
    typeof b.enabled !== 'boolean'
  )
    throw new TextFileError('HANDLE_INVALID', '目录连接记录不可用，请重新连接');
  return b;
}
function record(raw: unknown, key: OutputKey): OutputRecord {
  if (raw === undefined)
    return {
      schemaVersion: 1,
      key,
      revision: 0,
      dirty: true,
      status: 'pending',
      lastSuccess: null,
      intent: null,
      pendingSource: null,
      error: null,
      externalCopyPath: null,
    };
  const r = raw as OutputRecord;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    !equal(r.key, key) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    typeof r.dirty !== 'boolean'
  )
    throw new TextFileError('RECONCILE_REQUIRED', '文件状态记录无效，未覆盖磁盘');
  return r;
}
const sourceRevision = (s: TextSourceVersion) =>
  s.kind === 'journal' ? s.token.revision : s.dayRevision;
const sourceEpoch = (s: TextSourceVersion) => (s.kind === 'journal' ? s.token.epoch : s.epoch);
const documentEqual = (a: TextDocument, b: TextDocument) =>
  a.sha256 === b.sha256 && equal(a.source, b.source);
const view = (r: OutputRecord): TextOutputState => ({
  key: r.key,
  status: r.status,
  lastSuccess: r.lastSuccess,
  pendingSource: r.pendingSource,
  error: r.error,
  externalCopyPath: r.externalCopyPath,
});
const blocked = new Set([
  'failed',
  'permission-required',
  'conflict-copy-failed',
  'reconcile-required',
]);

/** One durable queue and native IO contract for journal and maintenance output. */
export function createTextOutputSession(options: {
  repository: TextRepository;
  source: TextSourceProvider;
  runtime?: TextRuntime;
  now?: () => string;
  id?: () => string;
  debounceMs?: number;
}) {
  const repo = options.repository,
    source = options.source,
    runtime = options.runtime ?? createBrowserTextRuntime(),
    now = options.now ?? (() => new Date().toISOString()),
    id = options.id ?? (() => crypto.randomUUID());
  const jobs = new Map<string, OutputKey>(),
    listeners = new Set<() => void>();
  // If IDB cannot even persist a failure (for example quota/abort), report it in
  // this session while retaining the last durable intent and successful output.
  const ioFailures = new Map<
    string,
    { status: OutputRecord['status']; error: string; pendingSource: TextSourceVersion | null }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined,
    worker: Promise<void> | null = null,
    discovery = Promise.resolve(),
    off: (() => void) | undefined,
    closed = false,
    started = false;
  const bus =
    typeof window === 'undefined' || typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('CardGrid:text-output-state');
  const emit = () => {
    for (const fn of listeners)
      try {
        fn();
      } catch {}
  };
  if (bus) bus.onmessage = emit;
  const changed = () => {
    emit();
    try {
      bus?.postMessage('changed');
    } catch {}
  };
  const check = (raw: unknown, active: unknown, b: FileBinding, key: OutputKey) => {
    const current = raw as { epoch?: string; data?: { version?: number } };
    if (current?.epoch !== key.epoch || b.epoch !== key.epoch)
      throw new TextFileError('WORKSPACE_REPLACED', '工作区已替换，文件同步暂停，旧文件保留');
    if (current.data?.version !== 5)
      throw new TextFileError('WORKSPACE_REPLACED', '当前工作区不是通用格式，文件同步暂停');
    if (
      active !== b.bindingId ||
      !b.enabled ||
      b.bindingId !== key.bindingId ||
      b.connectionVersion !== key.connectionVersion
    )
      throw new TextFileError('SOURCE_STALE', '目录连接已改变，旧任务未写入');
  };
  async function currentBinding() {
    const active = await repo.read(ACTIVE);
    return typeof active === 'string' ? binding(await repo.read(bindingKey(active))) : null;
  }
  async function guard(key: OutputKey) {
    return repo.atomic([ACTIVE, bindingKey(key.bindingId)], ([active, raw], workspace) => {
      const b = binding(raw);
      check(workspace, active, b, key);
      return { result: b };
    });
  }
  async function update(
    key: OutputKey,
    change: (before: OutputRecord, workspace: any) => OutputRecord,
  ) {
    return repo.atomic(
      [ACTIVE, bindingKey(key.bindingId), outputStorageKey(key)],
      ([active, b, r], workspace) => {
        check(workspace, active, binding(b), key);
        const before = record(r, key),
          after = { ...change(before, workspace), revision: before.revision + 1 };
        return { result: after, writes: [{ key: outputStorageKey(key), value: after }] };
      },
    );
  }
  async function event(
    b: FileBinding,
    operation: string,
    stage: 'requested' | 'succeeded' | 'failed',
    key?: OutputKey,
    errorCode?: string,
  ) {
    try {
      await source.event?.({
        epoch: b.epoch,
        bindingId: b.bindingId,
        connectionVersion: b.connectionVersion,
        operation,
        stage,
        key,
        errorCode,
      });
    } catch {
      /* log failure is reported by the separate maintenance collector */
    }
  }
  async function failed(
    key: OutputKey,
    error: unknown,
    pendingSource: TextSourceVersion | null = null,
  ) {
    const f = fileFailure(error);
    // A newer business revision can invalidate a projection while it is being
    // read. Keep the current namespace eligible for the queued source update;
    // update() checks binding, connection version and epoch in the same atomic
    // operation, so a disconnected/replaced namespace cannot be revived here.
    if (f.code === 'SOURCE_STALE')
      try {
        await update(key, (before) => ({
          ...before,
          dirty: true,
          status: 'pending',
          pendingSource: pendingSource ?? before.pendingSource,
          error: null,
        }));
        ioFailures.delete(outputStorageKey(key));
        changed();
        return f;
      } catch {
        /* A changed namespace or unavailable store retains the failure. */
      }
    const status =
      f.code === 'WORKSPACE_REPLACED'
        ? 'paused-after-replace'
        : f.code === 'PERMISSION_REQUIRED'
          ? 'permission-required'
          : f.code === 'EXTERNAL_COPY_FAILED'
            ? 'conflict-copy-failed'
            : f.code === 'RECONCILE_REQUIRED'
              ? 'reconcile-required'
              : 'failed';
    ioFailures.set(outputStorageKey(key), { status, error: f.message, pendingSource });
    try {
      await repo.atomic([outputStorageKey(key)], ([r], workspace) => {
        const before = record(r, key),
          epoch = (workspace as { epoch?: string })?.epoch;
        return {
          result: undefined,
          writes: [
            {
              key: outputStorageKey(key),
              value: {
                ...before,
                revision: before.revision + 1,
                dirty: true,
                status: epoch !== key.epoch ? 'paused-after-replace' : status,
                pendingSource: pendingSource ?? before.pendingSource,
                error: f.message,
              },
            },
          ],
        };
      });
    } catch {}
    changed();
    return f;
  }
  function visible(r: OutputRecord): OutputRecord {
    const failure = ioFailures.get(outputStorageKey(r.key));
    return failure
      ? { ...r, dirty: true, ...failure, pendingSource: failure.pendingSource ?? r.pendingSource }
      : r;
  }
  async function permission(b: FileBinding) {
    if ((await runtime.permission(b.handle, false)) !== 'granted')
      throw new TextFileError(
        'PERMISSION_REQUIRED',
        '目录写入权限已失效；主数据已保存，请点击重新授权后补写',
      );
  }
  async function verified(b: FileBinding, key: OutputKey, path: readonly string[], sha: string) {
    await guard(key);
    const actual = await runtime.read(b.handle, path);
    if (actual === null || (await hashTextBytes(actual)) !== sha)
      throw new TextFileError(
        'RECONCILE_REQUIRED',
        '文件关闭后字节核对失败；保留写入意图，请补写核对',
      );
  }
  async function adopt(
    b: FileBinding,
    key: OutputKey,
    document: TextDocument,
    intentId: string | null,
  ) {
    const latest = await source.render(key);
    if (
      sourceEpoch(latest.source) !== key.epoch ||
      sourceRevision(latest.source) < sourceRevision(document.source) ||
      (sourceRevision(latest.source) === sourceRevision(document.source) &&
        latest.source.inputFingerprint !== document.source.inputFingerprint)
    )
      throw new TextFileError('SOURCE_STALE', '文件源版本不可确认，未推进成功状态');
    const after = await update(key, (before, workspace) => {
      if (intentId !== null && before.intent?.intentId !== intentId)
        throw new TextFileError('SOURCE_STALE', '写入意图已改变');
      const dirty =
        !documentEqual(document, latest) ||
        (latest.source.kind === 'journal' && workspace.revision !== latest.source.token.revision);
      return {
        ...before,
        lastSuccess: { ...document, succeededAt: now() },
        intent: null,
        dirty,
        status: dirty ? 'pending' : 'synced',
        pendingSource: dirty ? latest.source : null,
        error: null,
      };
    });
    ioFailures.delete(outputStorageKey(key));
    changed();
    return after;
  }
  async function writeDocument(
    b: FileBinding,
    key: OutputKey,
    path: readonly string[],
    document: TextDocument,
  ) {
    const intentId = id();
    await update(key, (r) => ({
      ...r,
      status: 'writing',
      dirty: true,
      pendingSource: document.source,
      intent: { ...document, intentId, stage: 'prepared' },
      error: null,
    }));
    changed();
    await permission(b);
    await runtime.write(b.handle, path, bytes(document.text), async () => {
      await guard(key);
      await permission(b);
    });
    try {
      await update(key, (r) => {
        if (r.intent?.intentId !== intentId)
          throw new TextFileError('SOURCE_STALE', '写入意图已改变');
        return { ...r, intent: { ...r.intent, stage: 'closed' } };
      });
      await verified(b, key, path, document.sha256);
      await update(key, (r) => {
        if (r.intent?.intentId !== intentId)
          throw new TextFileError('SOURCE_STALE', '写入意图已改变');
        return { ...r, intent: { ...r.intent, stage: 'verified' } };
      });
      return await adopt(b, key, document, intentId);
    } catch (e) {
      if (
        e instanceof TextFileError &&
        ['WORKSPACE_REPLACED', 'SOURCE_STALE', 'PERMISSION_REQUIRED'].includes(e.code)
      )
        throw e;
      throw new TextFileError(
        'RECONCILE_REQUIRED',
        '文件可能已落盘，成功记录尚未确认；已保留写入意图，请补写核对',
      );
    }
  }
  async function run(key: OutputKey) {
    await runtime.lock(key.bindingId, async () => {
      for (let pass = 0; pass < 8 && !closed; pass++) {
        const b = await guard(key);
        await permission(b);
        const before = record(await repo.read(outputStorageKey(key)), key),
          latest = await source.render(key),
          path = outputPath(key, b.suffix),
          disk = await runtime.read(b.handle, path);
        const plan = await planTextReconciliation({
          key,
          currentKey: key,
          lastSuccess: before.lastSuccess,
          intent: before.intent,
          latest,
          diskBytes: disk,
        });
        if (plan.errorCode)
          throw new TextFileError(plan.errorCode, '旧文件任务已失效，未覆盖原文件');
        let previousHash = disk === null ? null : await hashTextBytes(disk),
          last = before;
        for (const step of plan.steps) {
          await guard(key);
          if (step.kind === 'preserve-external') {
            const copy = [
              ...path.slice(0, 3),
              'conflicts',
              `${key.kind}-${key.date}-${segment(key.zone)}.${segment(id())}.external.${b.suffix}`,
            ];
            try {
              const existing = await runtime.read(b.handle, copy);
              if (existing !== null)
                throw new TextFileError(
                  'EXTERNAL_COPY_FAILED',
                  '恢复副本名称已存在，未覆盖外部原文件',
                );
              await runtime.write(b.handle, copy, step.bytes, async () => {
                await guard(key);
                await permission(b);
              });
              await verified(b, key, copy, await hashTextBytes(step.bytes));
            } catch (e) {
              if (
                e instanceof TextFileError &&
                ['WORKSPACE_REPLACED', 'SOURCE_STALE'].includes(e.code)
              )
                throw e;
              throw new TextFileError(
                'EXTERNAL_COPY_FAILED',
                '外部修改副本保存或核对失败，已暂停覆盖原文件',
              );
            }
            last = await update(key, (r) => ({ ...r, externalCopyPath: copy.join('/') }));
            changed();
            await event(b, 'PreserveExternalText', 'succeeded', key);
          } else if (step.kind === 'record-reconciled') {
            await verified(b, key, path, step.document.sha256);
            last = await adopt(b, key, step.document, step.intentId);
          } else {
            const current = await runtime.read(b.handle, path),
              currentHash = current === null ? null : await hashTextBytes(current);
            if (currentHash !== previousHash)
              throw new TextFileError(
                'RECONCILE_REQUIRED',
                '检查后文件再次改变，已暂停覆盖，请主动刷新',
              );
            const document =
              step.kind === 'write-latest'
                ? step.document
                : {
                    text: step.text,
                    sha256: before.lastSuccess!.sha256,
                    source: before.lastSuccess!.source,
                  };
            last = await writeDocument(b, key, path, document);
            previousHash = document.sha256;
            if (step.kind === 'restore-last-success')
              await event(b, 'RestoreExternalText', 'succeeded', key);
          }
        }
        if (!plan.steps.length) {
          await verified(b, key, path, latest.sha256);
          last = await adopt(b, key, latest, null);
        }
        if (!last.dirty) return;
      }
      const r = record(await repo.read(outputStorageKey(key)), key);
      if (r.dirty) jobs.set(outputStorageKey(key), key);
    });
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!closed)
      timer = setTimeout(() => {
        timer = undefined;
        void drain().catch(() => changed());
      }, options.debounceMs ?? 500);
  }
  async function mark(b: FileBinding, date: OutputDate, manual: boolean, force = false) {
    assertDate(date.date);
    assertZone(date.zone);
    if (!['journal', 'maintenance'].includes(date.kind))
      throw new TextFileError('SOURCE_STALE', '文本类别无效');
    const key: OutputKey = {
      bindingId: b.bindingId,
      connectionVersion: b.connectionVersion,
      epoch: b.epoch,
      ...date,
    };
    let latest: TextDocument;
    try {
      latest = await source.render(key);
    } catch (e) {
      await failed(key, e);
      return;
    }
    const before = visible(record(await repo.read(outputStorageKey(key)), key));
    if (
      !manual &&
      !force &&
      !before.dirty &&
      before.lastSuccess &&
      documentEqual(before.lastSuccess, latest)
    )
      return;
    try {
      const r = await update(key, (r) => ({
        ...r,
        dirty: true,
        pendingSource: latest.source,
        status:
          manual || !blocked.has(before.status)
            ? r.status === 'writing'
              ? 'writing'
              : 'pending'
            : before.status,
      }));
      if (manual) {
        ioFailures.delete(outputStorageKey(key));
      } else if (ioFailures.has(outputStorageKey(key)))
        ioFailures.get(outputStorageKey(key))!.pendingSource = latest.source;
      if (manual || !blocked.has(r.status)) jobs.set(outputStorageKey(key), key);
    } catch (e) {
      await failed(key, e, latest.source);
    }
  }
  async function discover(manual = false, force = false) {
    const b = await currentBinding();
    if (!b || !b.enabled) return;
    const context = await source.context();
    if (context.epoch !== b.epoch || !context.v5) {
      jobs.clear();
      await repo.atomic([bindingKey(b.bindingId)], ([raw]) => ({
        result: undefined,
        writes: [
          {
            key: bindingKey(b.bindingId),
            value: { ...binding(raw), status: 'paused-after-replace' },
          },
        ],
      }));
      changed();
      return;
    }
    const dates = new Map<string, OutputDate>();
    for (const d of await source.dates()) dates.set(JSON.stringify(d), d);
    for (const k of await repo.keys(outputPrefix(b))) {
      const key = decodeKey(k);
      dates.set(JSON.stringify({ kind: key.kind, date: key.date, zone: key.zone }), {
        kind: key.kind,
        date: key.date,
        zone: key.zone,
      });
    }
    for (const d of dates.values()) await mark(b, d, manual, force);
    changed();
    if (jobs.size) schedule();
  }
  function enqueueDiscovery(manual = false, force = false) {
    discovery = discovery
      .catch(() => {})
      .then(() => (closed ? undefined : discover(manual, force)));
    return discovery;
  }
  async function drain() {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await discovery;
    if (worker) return worker;
    worker = (async () => {
      const batch = [...jobs.values()];
      jobs.clear();
      for (const key of batch) {
        if (closed) break;
        try {
          await run(key);
        } catch (e) {
          const f = await failed(key, e);
          try {
            await event(
              binding(await repo.read(bindingKey(key.bindingId))),
              'TextOutputFailed',
              'failed',
              key,
              f.code,
            );
          } catch {}
        }
      }
    })().finally(() => {
      worker = null;
      if (jobs.size && !closed) schedule();
    });
    return worker;
  }
  async function settle() {
    for (let pass = 0; pass < 8 && !closed; pass++) {
      await discovery;
      await drain();
      await discovery;
      if (!jobs.size && !worker) return;
    }
  }
  async function outputs(b: FileBinding) {
    const keys = new Set([
      ...(await repo.keys(outputPrefix(b))),
      ...[...ioFailures.keys()].filter((k) => k.startsWith(outputPrefix(b))),
    ]);
    return Promise.all(
      [...keys].map(async (k) => visible(record(await repo.read(k), decodeKey(k)))),
    );
  }
  async function connection(b: FileBinding): Promise<TextConnectionView> {
    const context = await source.context(),
      rows = await outputs(b),
      active = await repo.read(ACTIVE);
    const dirty = (r: OutputRecord) =>
      r.dirty ||
      (r.lastSuccess?.source.kind === 'journal' &&
        r.lastSuccess.source.token.revision !== context.revision);
    let status = b.status;
    if (!runtime.supported()) status = 'unsupported';
    else if (context.epoch !== b.epoch || !context.v5) status = 'paused-after-replace';
    else if (!b.enabled || active !== b.bindingId) status = 'disconnected';
    else if ((await runtime.permission(b.handle, false)) !== 'granted')
      status = 'permission-required';
    else
      status = rows.some((r) => r.status === 'conflict-copy-failed')
        ? 'conflict-copy-failed'
        : rows.some((r) => r.status === 'reconcile-required')
          ? 'reconcile-required'
          : rows.some((r) => r.status === 'failed')
            ? 'failed'
            : rows.some((r) => r.status === 'writing')
              ? 'writing'
              : rows.some(dirty)
                ? 'pending'
                : rows.length
                  ? 'synced'
                  : 'idle';
    return {
      bindingId: b.bindingId,
      connectionVersion: b.connectionVersion,
      epoch: b.epoch,
      suffix: b.suffix,
      status,
      pendingCount: rows.filter(dirty).length,
    };
  }
  const wrap = async <T>(work: () => Promise<T>): Promise<FileResult<T>> => {
    try {
      return { ok: true, value: await work() };
    } catch (e) {
      return fileFailure(e);
    }
  };
  async function activate(
    handle: FileBinding['handle'],
    input: { epoch: string; suffix: 'md' | 'txt' },
    old?: FileBinding,
  ) {
    const context = await source.context();
    if (context.epoch !== input.epoch || !context.v5)
      throw new TextFileError('WORKSPACE_REPLACED', '工作区已改变，请先重新读取再连接目录');
    const b: FileBinding = {
      schemaVersion: 1,
      bindingId: old?.bindingId ?? id(),
      connectionVersion: old
        ? old.connectionVersion + (old.epoch !== input.epoch || old.suffix !== input.suffix ? 1 : 0)
        : 1,
      epoch: input.epoch,
      suffix: input.suffix,
      handle,
      enabled: true,
      status: 'pending',
    };
    await runtime.lock(b.bindingId, () =>
      repo.atomic([ACTIVE, bindingKey(b.bindingId)], ([active, previous], workspace) => {
        if ((workspace as { epoch?: string })?.epoch !== input.epoch)
          throw new TextFileError('WORKSPACE_REPLACED', '连接时工作区已替换');
        if (
          old &&
          (!previous ||
            binding(previous).connectionVersion !== old.connectionVersion ||
            active !== old.bindingId)
        )
          throw new TextFileError('SOURCE_STALE', '目录连接已改变');
        return {
          result: undefined,
          writes: [
            { key: ACTIVE, value: b.bindingId },
            { key: bindingKey(b.bindingId), value: b },
          ],
        };
      }),
    );
    jobs.clear();
    await event(b, old ? 'ReconnectTextDirectory' : 'ConnectTextDirectory', 'succeeded');
    await enqueueDiscovery(true);
    changed();
    return connection(b);
  }
  const port: TextFilePort = {
    stamp: { contractVersion: 'v06-p0-1', backend: 'formal', release: 'draft' },
    connectTextDirectory: (input) =>
      wrap(async () => {
        if (!runtime.supported())
          throw new TextFileError(
            'UNSUPPORTED',
            '此浏览器缺少目录授权或跨窗口写锁，可手动下载文本',
          );
        if (!input.epoch || !['md', 'txt'].includes(input.suffix))
          throw new TextFileError('HANDLE_INVALID', '目录连接参数无效');
        const handle = await runtime.pickDirectory();
        if ((await runtime.permission(handle, false)) !== 'granted')
          throw new TextFileError('PERMISSION_REQUIRED', '目录尚未取得写入权限');
        return activate(handle, input);
      }),
    readTextSyncState: (input) =>
      wrap(async () => {
        const b = binding(await repo.read(bindingKey(input.bindingId)));
        return { connection: await connection(b), outputs: (await outputs(b)).map(view) };
      }),
    refreshTextFiles: (input) =>
      wrap(async () => {
        const b = binding(await repo.read(bindingKey(input.bindingId)));
        await guard({ ...input, kind: 'journal', date: '2000-01-01', zone: 'UTC' });
        await event(b, 'RefreshTextFiles', 'requested');
        await enqueueDiscovery(true);
        await settle();
        return connection(b);
      }),
    retryTextOutput: (input) =>
      wrap(async () => {
        const b = await guard(input.key);
        await event(b, 'RetryTextOutput', 'requested', input.key);
        await mark(b, input.key, true);
        await settle();
        return view(visible(record(await repo.read(outputStorageKey(input.key)), input.key)));
      }),
    disconnectTextDirectory: (input) =>
      wrap(async () => {
        await runtime.lock(input.bindingId, async () => {
          const b = binding(await repo.read(bindingKey(input.bindingId)));
          if (b.connectionVersion !== input.connectionVersion)
            throw new TextFileError('SOURCE_STALE', '连接版本已改变');
          await repo.atomic([ACTIVE, bindingKey(input.bindingId)], ([active, raw]) => {
            const live = binding(raw);
            if (active !== input.bindingId || live.connectionVersion !== input.connectionVersion)
              throw new TextFileError('SOURCE_STALE', '目录连接已改变');
            return {
              result: undefined,
              writes: [
                {
                  key: bindingKey(input.bindingId),
                  value: { ...live, enabled: false, status: 'disconnected' },
                },
              ],
            };
          });
          jobs.clear();
          await event(b, 'DisconnectTextDirectory', 'succeeded');
          changed();
        });
        return { disconnected: true as const };
      }),
  };
  return {
    ...port,
    get supported() {
      return runtime.supported();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async start() {
      if (started || !runtime.supported()) return;
      started = true;
      off = source.subscribe(() => {
        void enqueueDiscovery().catch(() => changed());
      });
      await enqueueDiscovery(false, true);
    },
    readActiveTextConnection: () =>
      wrap(async () => {
        const b = await currentBinding();
        return b ? connection(b) : null;
      }),
    reconnectTextDirectory: (input: {
      bindingId: string;
      connectionVersion: number;
      epoch: string;
      suffix?: 'md' | 'txt';
    }) =>
      wrap(async () => {
        if (!runtime.supported())
          throw new TextFileError('UNSUPPORTED', '此浏览器不支持自动文本写入');
        const b = binding(await repo.read(bindingKey(input.bindingId)));
        if (b.connectionVersion !== input.connectionVersion)
          throw new TextFileError('SOURCE_STALE', '目录连接版本已改变');
        if ((await runtime.permission(b.handle, true)) !== 'granted')
          throw new TextFileError('PERMISSION_REQUIRED', '未获得写入权限，主数据保持已保存');
        return activate(b.handle, { epoch: input.epoch, suffix: input.suffix ?? b.suffix }, b);
      }),
    requestTextOutput: (date: OutputDate) =>
      wrap(async () => {
        const b = await currentBinding();
        if (!b) throw new TextFileError('HANDLE_INVALID', '尚未连接文本目录，可手动下载');
        await mark(b, date, false);
        schedule();
        return connection(b);
      }),
    prepareTextDownload: (date: OutputDate) =>
      wrap(async () => {
        assertDate(date.date);
        assertZone(date.zone);
        const context = await source.context();
        return source.render({
          bindingId: 'manual-download',
          connectionVersion: 1,
          epoch: context.epoch,
          ...date,
        });
      }),
    flush: settle,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      off?.();
      try {
        await discovery;
      } catch {}
      await worker;
      jobs.clear();
      bus?.close();
      listeners.clear();
    },
  };
}
export type TextOutputSession = ReturnType<typeof createTextOutputSession>;

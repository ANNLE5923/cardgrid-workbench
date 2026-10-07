import type {
  DataV5,
  ArchiveRecordsV1,
  ArchiveRecordRef,
  MonthlyArchiveManifest,
} from './contracts-v06.ts';
import { archiveCollections, archiveKinds, archiveRefKey } from './archive-ledger.ts';
import { emptyWorkspaceData, canonicalJson } from './format.ts';
import { exactRecord, validateDataV5, catalogOf } from './v5-format.ts';
import { archiveNeed } from './archive-zip.ts';
import {
  dateAt,
  nextDate,
  compareInstants,
  assertDate,
  assertZone,
  dayRange,
} from '../daily/time.ts';
export const recordsOf = (data: DataV5): ArchiveRecordsV1['records'] =>
  Object.fromEntries(
    archiveCollections.map((k) => [
      k,
      k in data.planner ? (data.planner as any)[k] : (data as any)[k],
    ]),
  ) as ArchiveRecordsV1['records'];
export const recordId = (item: any) => item.id ?? item.factId;
/** Rebuild only an isolated read model. This is never imported into the active workspace. */
export function archiveData(pack: ArchiveRecordsV1, workspaceId: string): DataV5 {
  exactRecord(pack, [
    'format',
    'version',
    'catalogSnapshot',
    'settings',
    'catalogAliases',
    'definitions',
    'templates',
    'rules',
    'generationRules',
    'legacySources',
    'migrationBindings',
    'records',
  ]);
  archiveNeed(
    pack.format === 'cardgrid-monthly-records' && pack.version === 1,
    'ARCHIVE_INVALID',
    'records.json 格式错误',
  );
  exactRecord(pack.records, archiveCollections);
  for (const key of archiveCollections) {
    archiveNeed(Array.isArray(pack.records[key]), 'ARCHIVE_INVALID', '归档集合须为数组');
    const ids = pack.records[key].map(recordId);
    archiveNeed(
      ids.every((id) => typeof id === 'string' && !!id) && new Set(ids).size === ids.length,
      'ARCHIVE_INVALID',
      '记录缺少或重复 ID',
    );
  }
  const old = emptyWorkspaceData(),
    { bookEntries: discardEntries, pools: discardPools, ...base } = old,
    r = pack.records;
  const frames = r.history.filter((h) => h.type === 'ArchiveReadContextV1');
  archiveNeed(frames.length === 1, 'ARCHIVE_INCOMPLETE', '归档缺少唯一的表盘／来源上下文');
  const context = frames[0].after as any;
  exactRecord(context, ['format', 'version', 'days', 'occurrences', 'captures', 'refs', 'goals']);
  archiveNeed(
    context.format === 'cardgrid-archive-read-context' &&
      context.version === 1 &&
      frames[0].before === null &&
      frames[0].entity.kind === 'settings' &&
      'id' in frames[0].entity &&
      frames[0].entity.id === 'workspace',
    'ARCHIVE_INVALID',
    '包内上下文帧格式错误',
  );
  const history = r.history;
  const receipts = new Map<string, any>();
  for (const h of history)
    if (!h.type.startsWith('Migrate')) {
      const existing = receipts.get(h.commandId) ?? {
        commandId: h.commandId,
        type: h.type,
        payloadFingerprint: 'archive-read-model',
        resultRefs: [],
      };
      if (!existing.resultRefs.some((ref: any) => canonicalJson(ref) === canonicalJson(h.entity)))
        existing.resultRefs.push(h.entity);
      receipts.set(h.commandId, existing);
    }
  const generationLedger = history
    .filter(
      (h) =>
        h.type === 'GenerateDailyCopies' &&
        h.entity.kind === 'daily-copy' &&
        (h.after as any)?.ruleId,
    )
    .map((h) => {
      const c = h.after as any;
      return { ruleId: c.ruleId, sourceDate: c.sourceDate, copyId: c.id, at: c.generatedAt };
    });
  const archivedInstances = new Set(r.archiveLogs.flatMap((l) => l.acceptedInstanceIds));
  const data: DataV5 = {
    ...base,
    version: 5,
    workspaceId,
    ...pack.catalogSnapshot,
    settings: pack.settings,
    legacySources: pack.legacySources,
    migrationBindings: pack.migrationBindings,
    commandReceipts: [...receipts.values()],
    generationRules: pack.generationRules,
    dailyCopies: r.dailyCopies,
    archiveLogs: r.archiveLogs,
    generationLedger,
    journalEntries: r.journalEntries,
    journalNotes: r.journalNotes,
    handCards: r.handCards,
    referencePlacements: r.referencePlacements,
    factReferenceSnapshots: r.factReferenceSnapshots,
    catalogAliases: pack.catalogAliases,
    archiveIndex: [],
    planner: {
      ...old.planner,
      definitions: pack.definitions,
      templates: pack.templates,
      rules: pack.rules,
      instances: r.instances,
      plans: r.plans,
      facts: r.facts,
      annotations: r.annotations,
      fixed: r.fixed,
      history,
      handOrder: r.instances
        .filter(
          (i) =>
            i.state === 'open' &&
            !archivedInstances.has(i.id) &&
            !r.plans.some((p) => p.instanceId === i.id && p.status === 'active') &&
            !r.facts.some((f) => f.instanceId === i.id),
        )
        .map((i) => i.id),
      days: context.days,
      occurrences: context.occurrences,
      captures: context.captures,
      refs: context.refs,
      goals: context.goals,
    },
  };
  validateDataV5(data);
  return data;
}
export function recordDates(collection: string, item: any, zone: string): string[] {
  if (collection === 'journalEntries' || collection === 'journalNotes') return [item.date];
  if (collection === 'history') return [];
  const range = item.actualRange ?? item.range;
  if (range) {
    const dates: string[] = [];
    for (let d = dateAt(range.startAt, zone); d <= dateAt(range.endAt, zone); d = nextDate(d))
      if (compareInstants(dayRange(d, zone).startAt, range.endAt) < 0) dates.push(d);
    return dates;
  }
  if (item.mode === 'point') return [dateAt(item.point.at, zone)];
  if (item.sourceDate) return [item.sourceDate];
  return item.createdAt ? [dateAt(item.createdAt, zone)] : [];
}
/** Dependency components are sealed together. Unrepresented live references retain the component. */
export function selectMonthlyRecords(data: DataV5, month: string, zone: string, now: string) {
  assertDate(month + '-01');
  assertZone(zone);
  archiveNeed(month < dateAt(now, zone).slice(0, 7), 'ARCHIVE_INCOMPLETE', '只能归档已结束的月份');
  const all = recordsOf(data),
    nodes = new Map<
      string,
      {
        ref: ArchiveRecordRef;
        item: any;
        edges: Set<string>;
        reason: 'open' | 'cross-month' | 'live-reference' | 'idempotency' | null;
      }
    >();
  for (const collection of archiveCollections)
    if (collection !== 'history')
      for (const item of all[collection]) {
        const ref = { collection, id: recordId(item) };
        nodes.set(archiveRefKey(ref), { ref, item, edges: new Set(), reason: null });
      }
  const key = (collection: string, id: string) => JSON.stringify([collection, id]);
  const link = (a: string, collection: string, id: string) => {
    const b = key(collection, id);
    if (nodes.has(b)) {
      nodes.get(a)!.edges.add(b);
      nodes.get(b)!.edges.add(a);
    }
  };
  const protect = (collection: string, id: string) => {
    const n = nodes.get(key(collection, id));
    if (n) n.reason = 'live-reference';
  };
  for (const [k, n] of nodes) {
    const {
      item: i,
      ref: { collection: c },
    } = n;
    if (c === 'instances') {
      const fact = data.planner.facts.find((f) => f.instanceId === i.id);
      if (i.state === 'open' && !fact) n.reason = 'open';
      if (
        i.occurrenceId ||
        i.source.kind === 'capture' ||
        i.source.kind === 'occurrence' ||
        i.source.kind === 'makeup' ||
        i.makeupOf
      )
        n.reason = 'live-reference';
      if (i.makeupOf?.kind === 'occurrence') {
        const original = data.planner.occurrences.find((o) => o.id === i.makeupOf.id);
        if (original) link(k, 'instances', original.instanceId);
      }
    }
    if (['plans', 'facts'].includes(c)) link(k, 'instances', i.instanceId);
    if (c === 'annotations' || c === 'factReferenceSnapshots') link(k, 'facts', i.factId);
    if (c === 'handCards') {
      if (i.actionInstanceId) link(k, 'instances', i.actionInstanceId);
      for (const id of i.inputIds) link(k, 'handCards', id);
      if (i.consumedBy) link(k, 'handCards', i.consumedBy);
      for (const p of i.provenance)
        if (p.kind === 'daily-copy') {
          link(k, 'dailyCopies', p.copy.id);
          for (const a of data.archiveLogs.filter((a) => a.copyId === p.copy.id))
            link(k, 'archiveLogs', a.id);
        }
      const frozenAnswer =
        i.kind === 'answer' &&
        data.referencePlacements.some(
          (r) =>
            r.answerId === i.id &&
            r.mode === 'attached' &&
            data.planner.facts.some((f) => f.instanceId === r.targetInstanceId),
        );
      if (
        i.state === 'available' &&
        !frozenAnswer &&
        !(i.actionInstanceId && data.planner.facts.some((f) => f.instanceId === i.actionInstanceId))
      )
        n.reason = 'open';
    }
    if (c === 'referencePlacements') {
      link(k, 'handCards', i.answerId);
      if (i.mode === 'attached') link(k, 'instances', i.targetInstanceId);
      if (
        i.state === 'active' &&
        !(
          i.mode === 'attached' &&
          data.planner.facts.some((f) => f.instanceId === i.targetInstanceId)
        )
      )
        n.reason = 'live-reference';
    }
    if (c === 'dailyCopies' || c === 'archiveLogs') {
      for (const id of i.acceptedInstanceIds) link(k, 'instances', id);
      if (c === 'dailyCopies') n.reason = 'open';
    }
    if (c === 'factReferenceSnapshots')
      for (const answer of i.answers)
        for (const card of data.handCards.filter(
          (card) => card.kind === 'answer' && canonicalJson(card.answer) === canonicalJson(answer),
        ))
          link(k, 'handCards', card.id);
  }
  for (const day of data.planner.days) {
    for (const ref of day.top3) if (ref.kind === 'instance') protect('instances', ref.id);
    for (const ref of day.overrides) if (ref.fixedId) protect('fixed', ref.fixedId);
  }
  for (const capture of data.planner.captures)
    if (capture.target?.kind === 'instance') protect('instances', capture.target.id);
  for (const occurrence of data.planner.occurrences) protect('instances', occurrence.instanceId);
  for (const binding of data.migrationBindings)
    if ('id' in binding.target)
      for (const [collection, kind] of Object.entries(archiveKinds))
        if (kind === binding.target.kind) protect(collection, binding.target.id);
  // Histories that refer to multiple command entities are grouped, including consumed lineage.
  for (const receipt of data.commandReceipts) {
    const refs = receipt.resultRefs
      .flatMap((ref) =>
        'id' in ref
          ? Object.entries(archiveKinds)
              .filter(([, kind]) => kind === ref.kind)
              .map(([collection]) => key(collection, ref.id))
          : [],
      )
      .filter((k) => nodes.has(k));
    for (const a of refs)
      for (const b of refs)
        if (a !== b) {
          nodes.get(a)!.edges.add(b);
          nodes.get(b)!.edges.add(a);
        }
  }
  const visited = new Set<string>(),
    selected: ArchiveRecordRef[] = [],
    retained: {
      ref: ArchiveRecordRef;
      reason: 'open' | 'cross-month' | 'live-reference' | 'idempotency';
    }[] = [],
    copied = new Set<string>(),
    covered = new Set<string>();
  for (const k of nodes.keys()) {
    if (visited.has(k)) continue;
    const group: string[] = [],
      queue = [k];
    while (queue.length) {
      const q = queue.pop()!;
      if (visited.has(q)) continue;
      visited.add(q);
      group.push(q);
      queue.push(...nodes.get(q)!.edges);
    }
    const dates = group.flatMap((q) =>
      recordDates(nodes.get(q)!.ref.collection, nodes.get(q)!.item, zone),
    );
    if (!dates.some((d) => d.startsWith(month))) continue;
    const reason =
      group.map((q) => nodes.get(q)!.reason).find(Boolean) ??
      (dates.some((d) => d.slice(0, 7) > month) ? 'cross-month' : null);
    for (const q of group) {
      copied.add(q);
      const ref = nodes.get(q)!.ref;
      if (reason) retained.push({ ref, reason });
      else selected.push(ref);
    }
    for (const d of dates) if (d.slice(0, 7) <= month) covered.add(d);
  }
  // Freeze the exact saved-day overrides and workspace-local source metadata in
  // a named JSON context frame in the existing history collection. All context
  // dependencies are copied for viewing; runtime references keep their bodies live.
  const keepComponent = (collection: string, id: string) => {
    const queue = [key(collection, id)];
    while (queue.length) {
      const q = queue.pop()!;
      if (copied.has(q) || !nodes.has(q)) continue;
      copied.add(q);
      queue.push(...nodes.get(q)!.edges);
    }
  };
  for (const day of data.planner.days.filter((d) => covered.has(d.date))) {
    for (const ref of day.top3) if (ref.kind === 'instance') keepComponent('instances', ref.id);
    for (const override of day.overrides)
      if (override.fixedId) keepComponent('fixed', override.fixedId);
  }
  const sources = [
    ...data.actionCards,
    ...data.catalogEntries,
    ...data.decks,
    ...data.decisionCards,
    ...data.planner.definitions,
    ...data.planner.templates,
    ...data.planner.rules,
    ...data.generationRules,
  ].map((x) => x.source);
  for (const source of sources) {
    if (source.kind === 'capture') {
      const capture = data.planner.captures.find((c) => c.id === source.id);
      if (capture?.target?.kind === 'instance') keepComponent('instances', capture.target.id);
    }
    if (source.kind === 'occurrence' || source.kind === 'makeup') {
      const occurrence = data.planner.occurrences.find((o) => o.id === source.id);
      if (occurrence) keepComponent('instances', occurrence.instanceId);
    }
  }
  const copiedEntityKeys = new Set(
    [...copied].flatMap((k) => {
      const n = nodes.get(k)!,
        kind = archiveKinds[n.ref.collection];
      return kind ? [JSON.stringify([kind, n.ref.id])] : [];
    }),
  );
  const sourceKinds = [
    'action-card',
    'book-entry',
    'pool',
    'catalog-entry',
    'deck',
    'decision-card',
    'generation-rule',
    'definition',
    'template',
    'rule',
  ];
  const copiedSourceCopies = new Set(
    [...copied].flatMap((k) => {
      const n = nodes.get(k)!;
      return n.ref.collection === 'archiveLogs' ? [n.item.copyId] : [];
    }),
  );
  const history = data.planner.history.filter(
    (h) =>
      sourceKinds.includes(h.entity.kind) ||
      ('id' in h.entity &&
        (copiedEntityKeys.has(JSON.stringify([h.entity.kind, h.entity.id])) ||
          (h.entity.kind === 'daily-copy' && copiedSourceCopies.has(h.entity.id)))),
  );
  const removedEntityKeys = new Set(
    selected.flatMap((ref) =>
      archiveKinds[ref.collection] ? [JSON.stringify([archiveKinds[ref.collection], ref.id])] : [],
    ),
  );
  const removedSourceCopies = new Set(
    selected
      .filter((r) => r.collection === 'archiveLogs')
      .map((r) => data.archiveLogs.find((a) => a.id === r.id)!.copyId),
  );
  selected.push(
    ...history
      .filter(
        (h) =>
          'id' in h.entity &&
          (removedEntityKeys.has(JSON.stringify([h.entity.kind, h.entity.id])) ||
            (h.entity.kind === 'daily-copy' && removedSourceCopies.has(h.entity.id))),
      )
      .map((h) => ({ collection: 'history' as const, id: h.id })),
  );
  const copiedInstances = new Set(
    [...copied]
      .filter((k) => nodes.get(k)!.ref.collection === 'instances')
      .map((k) => nodes.get(k)!.ref.id),
  );
  let frameId = `archive-read-context:${JSON.stringify([data.workspaceId, month])}`;
  while (history.some((h) => h.id === frameId || h.commandId === frameId)) frameId += ':';
  history.push({
    id: frameId,
    commandId: frameId,
    type: 'ArchiveReadContextV1',
    at: now,
    date: dateAt(now, zone),
    entity: { kind: 'settings', id: 'workspace' },
    before: null,
    after: {
      format: 'cardgrid-archive-read-context',
      version: 1,
      days: data.planner.days.filter((d) => covered.has(d.date)),
      occurrences: data.planner.occurrences.filter((o) => copiedInstances.has(o.instanceId)),
      captures: data.planner.captures.filter(
        (c) =>
          (c.target?.kind === 'instance' && copiedInstances.has(c.target.id)) ||
          sources.some((s) => s.kind === 'capture' && s.id === c.id),
      ),
      refs: data.planner.refs,
      goals: data.planner.goals,
    } as any,
  });
  const records = Object.fromEntries(
    archiveCollections.map((c) => [
      c,
      c === 'history' ? history : all[c].filter((i) => copied.has(key(c, recordId(i)))),
    ]),
  ) as unknown as ArchiveRecordsV1['records'];
  const pack: ArchiveRecordsV1 = {
    format: 'cardgrid-monthly-records',
    version: 1,
    catalogSnapshot: catalogOf(data),
    settings: data.settings,
    catalogAliases: data.catalogAliases,
    definitions: data.planner.definitions,
    templates: data.planner.templates,
    rules: data.planner.rules,
    generationRules: data.generationRules,
    legacySources: data.legacySources,
    migrationBindings: data.migrationBindings.filter(
      (b) =>
        b.target.kind === 'legacy' ||
        ('id' in b.target &&
          (sourceKinds.includes(b.target.kind) ||
            copiedEntityKeys.has(JSON.stringify([b.target.kind, b.target.id])))),
    ),
    records,
  };
  archiveData(pack, data.workspaceId);
  return { pack, selected, retained, coveredDates: [...covered].sort() };
}
export function removeArchivedRecords(data: DataV5, selected: readonly ArchiveRecordRef[]): DataV5 {
  const removed = new Set(selected.map(archiveRefKey)),
    next = structuredClone(data) as any;
  for (const c of archiveCollections) {
    const keep = (i: any) => !removed.has(archiveRefKey({ collection: c, id: recordId(i) }));
    if (c in data.planner) next.planner[c] = next.planner[c].filter(keep);
    else next[c] = next[c].filter(keep);
  }
  next.planner.handOrder = next.planner.handOrder.filter((id: string) =>
    next.planner.instances.some((i: any) => i.id === id),
  );
  return next;
}
export function checkManifestRecords(manifest: MonthlyArchiveManifest, pack: ArchiveRecordsV1) {
  for (const c of archiveCollections)
    archiveNeed(
      (manifest.recordCounts[c] ?? 0) === pack.records[c].length,
      'ARCHIVE_INCOMPLETE',
      '归档清单计数与正文不符',
    );
  archiveData(pack, manifest.workspaceId);
}

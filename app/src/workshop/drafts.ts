/**
 * A2 form drafts: pure mapping between workshop entities and editable form state.
 * New ids are supplied by the caller (crypto.randomUUID), matching the command model.
 * The form and the advanced JSON editor both turn into the same entities and then
 * run the same A1 validators.
 */
import type {
  ActionCard, BookEntry, GenerationRule, GenerationSchedule, Id, Pool, SlotSpec,
} from '../workspace/index.ts';

/* ---- Book ---- */
export type BookForm = Readonly<{
  id: Id | null; version: number | null;
  title: string; author: string; status: BookEntry['status'];
}>;
export const emptyBookForm = (): BookForm => ({ id: null, version: null, title: '', author: '', status: 'active' });
export const bookToForm = (e: BookEntry): BookForm => ({
  id: e.id, version: e.version, title: e.title, author: e.author ?? '', status: e.status,
});
export const formToBook = (f: BookForm): BookEntry => ({
  id: f.id ?? '', version: f.version ?? 1, kind: 'book',
  title: f.title, author: f.author.trim() === '' ? null : f.author.trim(),
  status: f.status, source: { kind: 'manual' },
});

/* ---- Action card ---- */
export type SlotForm = Readonly<{ id: string; label: string; poolId: Id; required: boolean }>;
export type ActionForm = Readonly<{
  id: Id | null; version: number | null;
  title: string; criteria: string; presetText: string; color: string;
  slots: readonly SlotForm[]; status: ActionCard['status'];
}>;
export const emptyActionForm = (color = '#336699'): ActionForm => ({
  id: null, version: null, title: '', criteria: '', presetText: '30', color, slots: [], status: 'active',
});
export const actionToForm = (e: ActionCard): ActionForm => ({
  id: e.id, version: e.version, title: e.content.title, criteria: e.content.criteria,
  presetText: e.content.presetMinutes === null ? '' : String(e.content.presetMinutes),
  color: e.content.color,
  slots: e.slots.map(s => ({ id: s.id, label: s.label, poolId: s.poolId, required: s.required })),
  status: e.status,
});
export const formToAction = (f: ActionForm): ActionCard => ({
  id: f.id ?? '', version: f.version ?? 1, kind: 'action',
  content: {
    title: f.title, criteria: f.criteria,
    presetMinutes: f.presetText.trim() === '' ? null : Number(f.presetText),
    minimum: false, color: f.color, categoryId: null, categoryLabel: null,
    projectIds: [], goalIds: [], projectLabels: [], goalLabels: [],
  },
  slots: f.slots.map((s): SlotSpec => ({ id: s.id, label: s.label, poolId: s.poolId, required: s.required, valueKind: 'entry' })),
  status: f.status, parentId: null, source: { kind: 'manual' },
});

/* ---- Pool ---- */
export type PoolForm = Readonly<{
  id: Id | null; version: number | null;
  name: string; poolKind: Pool['poolKind']; parentPoolId: Id | ''; memberIds: readonly Id[];
}>;
export const emptyPoolForm = (kind: Pool['poolKind'] = 'book'): PoolForm => ({
  id: null, version: null, name: '', poolKind: kind, parentPoolId: '', memberIds: [],
});
export const poolToForm = (e: Pool): PoolForm => ({
  id: e.id, version: e.version, name: e.name, poolKind: e.poolKind,
  parentPoolId: e.parentPoolId ?? '', memberIds: e.memberIds,
});
export const formToPool = (f: PoolForm): Pool => ({
  id: f.id ?? '', version: f.version ?? 1, name: f.name, poolKind: f.poolKind,
  parentPoolId: f.parentPoolId === '' ? null : f.parentPoolId,
  memberIds: f.memberIds, source: { kind: 'manual' },
});

/* ---- Generation rule ---- */
export type RuleForm = Readonly<{
  id: Id | null; version: number | null;
  name: string; actionCardId: Id | '';
  scheduleMode: GenerationSchedule['mode']; weekdays: readonly number[];
  startDate: string; zone: string; status: GenerationRule['status'];
}>;
export const emptyRuleForm = (zone = 'Asia/Shanghai'): RuleForm => ({
  id: null, version: null, name: '', actionCardId: '',
  scheduleMode: 'daily', weekdays: [1, 2, 3, 4, 5],
  startDate: '', zone, status: 'active',
});
export const ruleToForm = (e: GenerationRule): RuleForm => ({
  id: e.id, version: e.version, name: e.name, actionCardId: e.actionCardId,
  scheduleMode: e.schedule.mode,
  weekdays: e.schedule.mode === 'weekdays' ? e.schedule.weekdays : [],
  startDate: e.startDate, zone: e.zone, status: e.status,
});
export const formToRule = (f: RuleForm): GenerationRule => ({
  id: f.id ?? '', version: f.version ?? 1, name: f.name,
  actionCardId: f.actionCardId === '' ? '' : f.actionCardId,
  schedule: f.scheduleMode === 'daily' ? { mode: 'daily' } : { mode: 'weekdays', weekdays: f.weekdays },
  startDate: f.startDate, zone: f.zone, status: f.status, source: { kind: 'manual' },
});

/** JSON is parsed to an entity and validated by the same validators as the form. */
export const parseWorkshopJson = (text: string): unknown => JSON.parse(text);

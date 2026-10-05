import type {ActionCard, BookEntry, GenerationRule, Pool, WorkshopCatalog} from '../../../src/workshop/model.ts';
import {content} from '../../fixtures/action/independent.ts';

export const actionCard = (patch: Partial<ActionCard> = {}): ActionCard => ({
  id: 'reading', version: 1, kind: 'action', content: {...content(), title: '阅读《{书名}》'},
  slots: [{id: 'book', label: '书名', poolId: 'books', required: true, valueKind: 'entry'}],
  status: 'active', parentId: null, source: {kind: 'manual'}, ...patch,
});
export const bookEntry = (patch: Partial<BookEntry> = {}): BookEntry => ({
  id: 'book-1', version: 1, kind: 'book', title: '百年孤独', author: null, status: 'active', source: {kind: 'manual'}, ...patch,
});
export const pool = (patch: Partial<Pool> = {}): Pool => ({
  id: 'books', version: 1, name: '书目池', poolKind: 'book', parentPoolId: null, memberIds: ['book-1'], source: {kind: 'manual'}, ...patch,
});
export const rule = (patch: Partial<GenerationRule> = {}): GenerationRule => ({
  id: 'daily-reading', version: 1, name: '每日阅读', actionCardId: 'reading',
  schedule: {mode: 'daily'}, startDate: '2026-10-04', zone: 'Asia/Shanghai', status: 'active', source: {kind: 'manual'}, ...patch,
});
export const catalog = (patch: Partial<WorkshopCatalog> = {}): WorkshopCatalog => ({
  actionCards: [actionCard(), actionCard({id: 'walk', content: {...content(), title: '散步'}, slots: []})],
  bookEntries: [bookEntry()], pools: [pool(), pool({id: 'actions', name: '行动池', poolKind: 'action', memberIds: ['reading', 'walk']})],
  generationRules: [rule()], ...patch,
});

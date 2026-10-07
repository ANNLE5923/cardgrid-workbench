/**
 * A2 catalog editor: pure, in-memory application of v0.6 catalog mutations.
 * This is NOT persistence. It models the command / validation / optimistic-
 * concurrency semantics the real Host (B4) will provide, so the editor UI can
 * be built and tested before the IndexedDB-backed host exists. No React, no
 * storage: the state is lost on reload. Outputs are detached clones.
 */
import { validateV06Dto, V06ContractError } from '../workspace/v06.ts';
import type {
  ActionCardV5,
  AnswerSnapshot,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  Deck,
  FieldResolution,
  HandCard,
  LiveView,
  SynthesisPreview,
  UnifiedHandItem,
  V06ErrorCode,
  V06PortStamp,
  V06Result,
} from '../workspace/v06.ts';
import type { Id, Instant, Token, VersionRef } from '../workspace/index.ts';
import { MAX_DECK_MEMBERS, validateCatalogV06 } from './catalog-v06.ts';
import { buildSynthesisPreview } from './synthesis-preview.ts';

export type EditorResult<T> = V06Result<T>;
export type SaveEntityInput<T> = Readonly<{ draft: T; expectedVersion: number | null }>;
export type MoveMemberInput = Readonly<{
  entry: VersionRef;
  from: VersionRef;
  to: VersionRef;
  targetIndex: number;
}>;

/** Narrow surface the A2 editor depends on; a B4 host can be adapted to it. */
export interface CatalogEditorHost {
  readonly stamp: V06PortStamp;
  readCatalog(): Promise<EditorResult<LiveView<CatalogV06>>>;
  readHand(): Promise<EditorResult<LiveView<readonly UnifiedHandItem[]>>>;
  saveAction(
    input: SaveEntityInput<ActionCardV5>,
  ): Promise<EditorResult<Readonly<{ action: ActionCardV5; token: Token }>>>;
  saveEntry(
    input: SaveEntityInput<CatalogEntry>,
  ): Promise<EditorResult<Readonly<{ entry: CatalogEntry; token: Token }>>>;
  saveDeck(
    input: SaveEntityInput<Deck>,
  ): Promise<EditorResult<Readonly<{ deck: Deck; token: Token }>>>;
  saveDecision(
    input: SaveEntityInput<DecisionCard>,
  ): Promise<EditorResult<Readonly<{ decision: DecisionCard; token: Token }>>>;
  moveMember(input: MoveMemberInput): Promise<EditorResult<Readonly<{ token: Token }>>>;
  takeAction(
    input: Readonly<{ action: VersionRef }>,
  ): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>>;
  takeEntry(
    input: Readonly<{ entry: VersionRef }>,
  ): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>>;
  /** Temporary: stage an accepted answer material (B5 selectDecisionEntry replaces it). */
  stageAnswerMaterial(
    input: Readonly<{ decision: VersionRef; entry: VersionRef }>,
  ): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>>;
  previewSynthesis(
    input: Readonly<{
      inputs: readonly [VersionRef, VersionRef];
      resolutions: readonly FieldResolution[];
    }>,
  ): Promise<EditorResult<SynthesisPreview>>;
  confirmSynthesis(
    input: Readonly<{ previewId: Id }>,
  ): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>>;
  /** A4 temporary decision session (B1/B5 replace it). */
  listDecisionCandidates(
    input: Readonly<{ decision: VersionRef }>,
  ): Promise<EditorResult<DecisionCandidatesView>>;
  previewDecisionDraw(
    input: Readonly<{ decision: VersionRef; choice: DrawChoice }>,
  ): Promise<EditorResult<DecisionDrawPreview>>;
  acceptDecisionAnswer(
    input: Readonly<{ decision: VersionRef; entry: VersionRef; alsoTakeAction: boolean }>,
  ): Promise<EditorResult<Readonly<{ answer: HandCard; action: HandCard | null; token: Token }>>>;
}

export type InMemoryEditorOptions = Readonly<{
  token?: Token;
  now?: () => Instant;
  nextId?: (hint: string) => Id;
  rng?: () => number;
}>;

// A4 session views (mirrors decision/ui; kept structurally compatible so the
// in-memory host can serve the DecisionSessionPort without importing the UI).
export type DecisionCandidatesView = Readonly<{
  decision: VersionRef;
  candidates: readonly Readonly<{ entry: VersionRef; title: string }>[];
  sourceDeckIds: readonly Id[];
}>;
export type DecisionDrawPreview = Readonly<{
  decision: VersionRef;
  candidates: readonly Readonly<{ entry: VersionRef; title: string }>[];
  selected: AnswerSnapshot;
  sourceFingerprint: string;
}>;
export type DrawChoice =
  Readonly<{ kind: 'random' }> | Readonly<{ kind: 'manual'; entry: VersionRef }>;

export function createInMemoryCatalogEditor(
  seed: CatalogV06,
  options: InMemoryEditorOptions = {},
): CatalogEditorHost {
  const clock = options.now ?? (() => new Date().toISOString());
  let counter = 0;
  const nextId = options.nextId ?? ((hint: string) => `${hint}-${++counter}`);
  const rng = options.rng ?? Math.random;
  const state: { catalog: CatalogV06; hand: HandCard[]; token: Token } = {
    catalog: structuredClone(seed),
    hand: [],
    token: options.token ?? { epoch: 'in-memory-editor', revision: 1 },
  };

  const bump = (): Token => {
    state.token = { epoch: state.token.epoch, revision: state.token.revision + 1 };
    return state.token;
  };
  const cloneToken = (): Token => ({ ...state.token });
  const failure = (
    code: V06ErrorCode,
    message: string,
    retry: 'edit' | 'reload' | 'none' | 'preview',
    field?: string,
  ): EditorResult<never> => ({ ok: false, code, message, retry, ...(field ? { field } : {}) });
  const previews = new Map<Id, SynthesisPreview>();

  /** Effective candidates: active entries in the union of the decision's
   * entry-kind candidate decks, de-duplicated by id, first-seen order. */
  const computeCandidates = (catalog: CatalogV06, dec: DecisionCard): CatalogEntry[] => {
    const deckById = new Map(catalog.decks.map((d) => [d.id, d]));
    const seen = new Set<Id>();
    const out: CatalogEntry[] = [];
    for (const deckId of dec.deckIds) {
      const deck = deckById.get(deckId);
      if (!deck || deck.deckKind !== 'entry') continue;
      for (const memberId of deck.memberIds) {
        if (seen.has(memberId)) continue;
        const entry = catalog.catalogEntries.find((e) => e.id === memberId);
        if (!entry || entry.status !== 'active') continue;
        seen.add(memberId);
        out.push(entry);
      }
    }
    return out;
  };

  const buildAnswerSnapshot = (
    catalog: CatalogV06,
    dec: DecisionCard,
    target: CatalogEntry,
    now: Instant,
  ): AnswerSnapshot => {
    const fieldValues = dec.mappings.map((m) => ({
      fieldId: m.fieldId,
      value:
        m.entryPath === 'title'
          ? target.title
          : (target.attributes[m.entryPath.slice('attributes.'.length)] ?? null),
    }));
    return {
      decision: { id: dec.id, version: dec.version },
      question: dec.question,
      ownerAction: {
        id: dec.ownerActionId,
        version: catalog.actionCards.find((a) => a.id === dec.ownerActionId)!.version,
      },
      entry: target,
      sourceDecks: dec.deckIds.map((id) => ({
        id,
        version: catalog.decks.find((d) => d.id === id)!.version,
      })),
      mappings: dec.mappings,
      fieldValues,
      selectedAt: now,
    };
  };

  /** Load and version-check a decision; null result means a failure was returned. */
  const loadDecision = (
    decision: VersionRef,
    needActive: boolean,
  ): EditorResult<never> | DecisionCard => {
    const dec = state.catalog.decisionCards.find((d) => d.id === decision.id);
    if (!dec) return failure('INVALID_INPUT', `决策「${decision.id}」不存在`, 'edit');
    if (decision.version !== dec.version)
      return failure('REVISION_CONFLICT', '决策已变化，请刷新', 'reload');
    if (needActive && dec.status !== 'active')
      return failure('ENTRY_UNAVAILABLE', `决策当前为「${dec.status}」，不可操作`, 'edit');
    return dec;
  };
  const isFailure = <T>(v: EditorResult<never> | T): v is EditorResult<never> =>
    typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

  /** Reject a draft that fails the P0 shape validator; otherwise null. */
  const shapeError = (
    kind: 'entry' | 'deck' | 'action' | 'decision',
    draft: unknown,
  ): V06ContractError | null => {
    try {
      validateV06Dto(kind, draft);
      return null;
    } catch (e) {
      if (e instanceof V06ContractError) return e;
      throw e;
    }
  };

  /** Transactional persist helper shared by entry/deck/decision saves. */
  function persist<T extends { id: Id; version: number }>(
    kind: 'entry' | 'deck' | 'action' | 'decision',
    collection: readonly T[],
    draft: T,
    expectedVersion: number | null,
    replaceCollection: (next: readonly T[]) => CatalogV06,
  ): EditorResult<Readonly<{ entity: T; token: Token }>> {
    const dtoError = shapeError(kind, draft);
    if (dtoError) return failure(dtoError.code, dtoError.message, 'edit', dtoError.field);

    const index = collection.findIndex((item) => item.id === draft.id);
    if (index === -1) {
      if (expectedVersion !== null)
        return failure('INVALID_INPUT', '新建实体的期望版本必须为空', 'edit');
      const candidate = replaceCollection([...collection, draft]);
      const gate = validateCatalogV06(candidate);
      if (!gate.valid) {
        const g0 = gate.issues[0];
        return failure('INVALID_INPUT', `${g0.code} ${g0.path}: ${g0.message}`, 'edit');
      }
      state.catalog = candidate;
      return { ok: true, value: { entity: draft, token: cloneTokenAfterBump() } };
    }

    if (expectedVersion === null)
      return failure('INVALID_INPUT', '已存在的实体需提供期望版本', 'edit');
    const current = collection[index];
    if (current.version !== expectedVersion)
      return failure('REVISION_CONFLICT', '该实体已被其他操作修改，请刷新后重试', 'reload');
    const saved = { ...draft, version: current.version + 1 };
    const candidate = replaceCollection(
      collection.map((item) => (item.id === saved.id ? saved : item)),
    );
    const gate = validateCatalogV06(candidate);
    if (!gate.valid) {
      const g0 = gate.issues[0];
      return failure('INVALID_INPUT', `${g0.code} ${g0.path}: ${g0.message}`, 'edit');
    }
    state.catalog = candidate;
    return { ok: true, value: { entity: saved, token: cloneTokenAfterBump() } };
  }
  const cloneTokenAfterBump = (): Token => {
    bump();
    return cloneToken();
  };

  return {
    stamp: { contractVersion: 'v06-p0-1', backend: 'test-adapter', release: 'draft' },

    async readCatalog() {
      const value: LiveView<CatalogV06> = {
        access: 'live',
        token: cloneToken(),
        data: structuredClone(state.catalog),
      };
      return { ok: true, value };
    },

    async readHand() {
      const items: readonly UnifiedHandItem[] = state.hand.map((card) => ({
        card,
        usableInToday: true,
        unavailableReason: null,
      }));
      const value: LiveView<readonly UnifiedHandItem[]> = {
        access: 'live',
        token: cloneToken(),
        data: items,
      };
      return { ok: true, value };
    },

    async saveEntry({ draft, expectedVersion }) {
      const result = persist(
        'entry',
        state.catalog.catalogEntries,
        draft,
        expectedVersion,
        (catalogEntries) => ({ ...state.catalog, catalogEntries }),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: { entry: result.value.entity as CatalogEntry, token: result.value.token },
      };
    },

    async saveAction({ draft, expectedVersion }) {
      const result = persist(
        'action',
        state.catalog.actionCards,
        draft,
        expectedVersion,
        (actionCards) => ({ ...state.catalog, actionCards }),
      );
      if (!result.ok) return result;
      return { ok: true, value: { action: result.value.entity, token: result.value.token } };
    },

    async saveDeck({ draft, expectedVersion }) {
      const result = persist('deck', state.catalog.decks, draft, expectedVersion, (decks) => ({
        ...state.catalog,
        decks,
      }));
      if (!result.ok) return result;
      return { ok: true, value: { deck: result.value.entity as Deck, token: result.value.token } };
    },

    async saveDecision({ draft, expectedVersion }) {
      const result = persist(
        'decision',
        state.catalog.decisionCards,
        draft,
        expectedVersion,
        (decisionCards) => ({ ...state.catalog, decisionCards }),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: { decision: result.value.entity as DecisionCard, token: result.value.token },
      };
    },

    async moveMember({ entry, from, to, targetIndex }) {
      if (!Number.isSafeInteger(targetIndex) || targetIndex < 0)
        return failure('INVALID_INPUT', '目标位置必须是不小于 0 的整数', 'edit');
      const fromDeck = state.catalog.decks.find((d) => d.id === from.id);
      if (!fromDeck) return failure('INVALID_INPUT', `来源牌堆「${from.id}」不存在`, 'edit');
      const toDeck = state.catalog.decks.find((d) => d.id === to.id);
      if (!toDeck) return failure('INVALID_INPUT', `目标牌堆「${to.id}」不存在`, 'edit');
      if (from.version !== fromDeck.version)
        return failure('REVISION_CONFLICT', '来源牌堆已变化，请刷新', 'reload');
      if (toDeck.id !== fromDeck.id && to.version !== toDeck.version)
        return failure('REVISION_CONFLICT', '目标牌堆已变化，请刷新', 'reload');

      const memberExists =
        toDeck.deckKind === 'entry'
          ? state.catalog.catalogEntries.some((e) => e.id === entry.id)
          : toDeck.deckKind === 'action'
            ? state.catalog.actionCards.some((a) => a.id === entry.id)
            : state.catalog.decisionCards.some((d) => d.id === entry.id);
      if (!memberExists)
        return failure(
          'ENTRY_UNAVAILABLE',
          `成员「${entry.id}」不存在，或与目标牌堆类型不匹配`,
          'edit',
        );
      const fromIndex = fromDeck.memberIds.indexOf(entry.id);
      if (fromIndex === -1)
        return failure('INVALID_INPUT', `成员「${entry.id}」不在来源牌堆中`, 'edit');

      let nextFrom = fromDeck.memberIds.slice();
      let nextTo: Id[];
      if (toDeck.id === fromDeck.id) {
        nextTo = nextFrom;
        nextFrom.splice(fromIndex, 1);
        nextTo.splice(Math.min(targetIndex, nextTo.length), 0, entry.id);
      } else {
        if (toDeck.memberIds.length >= MAX_DECK_MEMBERS)
          return failure(
            'POOL_CAPACITY_EXCEEDED',
            `目标牌堆已达 ${MAX_DECK_MEMBERS} 个成员上限`,
            'edit',
          );
        nextFrom.splice(fromIndex, 1);
        nextTo = toDeck.memberIds.slice();
        nextTo.splice(Math.min(targetIndex, nextTo.length), 0, entry.id);
      }

      const decks = state.catalog.decks.map((d) => {
        if (d.id === fromDeck.id) return { ...d, memberIds: nextFrom, version: d.version + 1 };
        if (d.id === toDeck.id && toDeck.id !== fromDeck.id)
          return { ...d, memberIds: nextTo, version: d.version + 1 };
        return d;
      });
      const candidate = { ...state.catalog, decks };
      const gate = validateCatalogV06(candidate);
      if (!gate.valid) {
        const g0 = gate.issues[0];
        return failure('INVALID_INPUT', `${g0.code} ${g0.path}: ${g0.message}`, 'edit');
      }
      state.catalog = candidate;
      return { ok: true, value: { token: cloneTokenAfterBump() } };
    },

    async takeAction({ action }) {
      const def = state.catalog.actionCards.find((a) => a.id === action.id);
      if (!def) return failure('INVALID_INPUT', `行动「${action.id}」不存在`, 'edit');
      if (action.version !== def.version)
        return failure('REVISION_CONFLICT', '行动卡已变化，请刷新', 'reload');
      if (def.status !== 'active')
        return failure('ENTRY_UNAVAILABLE', `行动当前状态为「${def.status}」，不可拿取`, 'edit');
      const now = clock();
      const card: HandCard = {
        id: nextId('action-material'),
        version: 1,
        kind: 'action',
        state: 'available',
        createdAt: now,
        provenance: [{ kind: 'manual', source: { id: def.id, version: def.version } }],
        inputIds: [],
        expiresAt: null,
        consumedBy: null,
        actionInstanceId: null,
        ownerAction: { id: def.id, version: def.version },
        contentSnapshot: def.content,
        fieldSpecs: def.fields,
        fieldValues: [],
      };
      state.hand.push(card);
      return { ok: true, value: { card, token: cloneTokenAfterBump() } };
    },

    async takeEntry({ entry }) {
      const def = state.catalog.catalogEntries.find((e) => e.id === entry.id);
      if (!def) return failure('INVALID_INPUT', `资源条目「${entry.id}」不存在`, 'edit');
      if (entry.version !== def.version)
        return failure('REVISION_CONFLICT', '条目已变化，请刷新', 'reload');
      if (def.status !== 'active')
        return failure('ENTRY_UNAVAILABLE', `条目当前状态为「${def.status}」，不可拿取`, 'edit');
      const now = clock();
      const card: HandCard = {
        id: nextId('entry-material'),
        version: 1,
        kind: 'entry',
        state: 'available',
        createdAt: now,
        provenance: [{ kind: 'manual', source: { id: def.id, version: def.version } }],
        inputIds: [],
        expiresAt: null,
        consumedBy: null,
        entrySnapshot: def,
      };
      state.hand.push(card);
      return { ok: true, value: { card, token: cloneTokenAfterBump() } };
    },

    async stageAnswerMaterial({ decision, entry }) {
      const loaded = loadDecision(decision, true);
      if (isFailure(loaded)) return loaded;
      const dec = loaded;
      const target = computeCandidates(state.catalog, dec).find((e) => e.id === entry.id);
      if (!target)
        return failure(
          'ENTRY_UNAVAILABLE',
          '答案条目不在该决策的有效候选中（或已归档），请重选',
          'edit',
        );
      if (entry.version !== target.version)
        return failure('REVISION_CONFLICT', '条目已变化，请刷新', 'reload');
      const now = clock();
      const snapshot = buildAnswerSnapshot(state.catalog, dec, target, now);
      const card: HandCard = {
        id: nextId('answer-material'),
        version: 1,
        kind: 'answer',
        state: 'available',
        createdAt: now,
        provenance: [{ kind: 'answer', snapshot }],
        inputIds: [],
        expiresAt: null,
        consumedBy: null,
        answer: snapshot,
      };
      state.hand.push(card);
      return { ok: true, value: { card, token: cloneTokenAfterBump() } };
    },

    async listDecisionCandidates({ decision }) {
      const loaded = loadDecision(decision, false);
      if (isFailure(loaded)) return loaded;
      const dec = loaded;
      const candidates = computeCandidates(state.catalog, dec).map((e) => ({
        entry: { id: e.id, version: e.version },
        title: e.title,
      }));
      const value: DecisionCandidatesView = {
        decision: { id: dec.id, version: dec.version },
        candidates,
        sourceDeckIds: dec.deckIds,
      };
      return { ok: true, value };
    },

    async previewDecisionDraw({ decision, choice }) {
      const loaded = loadDecision(decision, true);
      if (isFailure(loaded)) return loaded;
      const dec = loaded;
      const effective = computeCandidates(state.catalog, dec);
      if (effective.length === 0)
        return failure('ENTRY_UNAVAILABLE', '候选牌堆中没有可用条目，请先添加或解除归档', 'edit');
      let target: CatalogEntry;
      if (choice.kind === 'random') {
        const index = Math.min(Math.floor(rng() * effective.length), effective.length - 1);
        target = effective[index]!;
      } else {
        const found = effective.find((e) => e.id === choice.entry.id);
        if (!found) return failure('ENTRY_UNAVAILABLE', '手选条目不在有效候选中，请重选', 'edit');
        if (choice.entry.version !== found.version)
          return failure('REVISION_CONFLICT', '条目已变化，请重选', 'reload');
        target = found;
      }
      const selected = buildAnswerSnapshot(state.catalog, dec, target, clock());
      const candidates = effective.map((e) => ({
        entry: { id: e.id, version: e.version },
        title: e.title,
      }));
      const value: DecisionDrawPreview = {
        decision: { id: dec.id, version: dec.version },
        candidates,
        selected,
        sourceFingerprint: `${dec.id}@${dec.version}:${target.id}@${target.version}`,
      };
      return { ok: true, value };
    },

    async acceptDecisionAnswer({ decision, entry, alsoTakeAction }) {
      const loaded = loadDecision(decision, true);
      if (isFailure(loaded)) return loaded;
      const dec = loaded;
      const target = computeCandidates(state.catalog, dec).find((e) => e.id === entry.id);
      if (!target)
        return failure('ENTRY_UNAVAILABLE', '答案条目不在有效候选中（或已归档），请重选', 'edit');
      if (entry.version !== target.version)
        return failure('REVISION_CONFLICT', '条目已变化，请重选', 'reload');
      const owner = state.catalog.actionCards.find((a) => a.id === dec.ownerActionId);
      if (!owner) return failure('INVALID_INPUT', `归属行动「${dec.ownerActionId}」不存在`, 'edit');
      if (alsoTakeAction && owner.status !== 'active')
        return failure(
          'ENTRY_UNAVAILABLE',
          `归属行动当前为「${owner.status}」，不能同时拿牌`,
          'edit',
        );

      const now = clock();
      const snapshot = buildAnswerSnapshot(state.catalog, dec, target, now);
      const answerCard: HandCard = {
        id: nextId('answer-material'),
        version: 1,
        kind: 'answer',
        state: 'available',
        createdAt: now,
        provenance: [{ kind: 'answer', snapshot }],
        inputIds: [],
        expiresAt: null,
        consumedBy: null,
        answer: snapshot,
      };
      state.hand.push(answerCard);
      let actionCard: HandCard | null = null;
      if (alsoTakeAction) {
        actionCard = {
          id: nextId('action-material'),
          version: 1,
          kind: 'action',
          state: 'available',
          createdAt: now,
          provenance: [{ kind: 'manual', source: { id: owner.id, version: owner.version } }],
          inputIds: [],
          expiresAt: null,
          consumedBy: null,
          actionInstanceId: null,
          ownerAction: { id: owner.id, version: owner.version },
          contentSnapshot: owner.content,
          fieldSpecs: owner.fields,
          fieldValues: [],
        };
        state.hand.push(actionCard);
      }
      return {
        ok: true,
        value: { answer: answerCard, action: actionCard, token: cloneTokenAfterBump() },
      };
    },

    async previewSynthesis({ inputs, resolutions }) {
      const actionCard = state.hand.find((c) => c.id === inputs[0].id);
      const answerCard = state.hand.find((c) => c.id === inputs[1].id);
      if (!actionCard || (actionCard.kind !== 'action' && actionCard.kind !== 'composite'))
        return failure('INVALID_INPUT', '槽 1 需要一张本次行动（或已合成）素材', 'edit');
      if (!answerCard || answerCard.kind !== 'answer')
        return failure('INVALID_INPUT', '槽 2 需要一张本次答案素材', 'edit');
      if (inputs[0].version !== actionCard.version || inputs[1].version !== answerCard.version)
        return failure('REVISION_CONFLICT', '素材已变化，请重新选择', 'reload');
      const previewId = nextId('synthesis-preview');
      const built = buildSynthesisPreview({
        token: cloneToken(),
        previewId,
        outputId: nextId('composite'),
        now: clock(),
        action: actionCard,
        answer: answerCard,
        resolutions,
      });
      if (!built.ok) return built;
      previews.set(previewId, built.value);
      return built;
    },

    async confirmSynthesis({ previewId }) {
      const preview = previews.get(previewId);
      if (!preview)
        return failure('INVALID_INPUT', '合成预览不存在或已失效，请重新预览', 'preview');
      if (!preview.ready)
        return failure(
          'REQUIRED_FIELD_EMPTY',
          '成品仍有未解决冲突或必填字段缺失，不能确认',
          'edit',
        );
      const a = state.hand.find((c) => c.id === preview.inputs[0].id);
      const b = state.hand.find((c) => c.id === preview.inputs[1].id);
      const matches = (card: HandCard | undefined, ref: VersionRef) =>
        card !== undefined && card.version === ref.version && card.state === 'available';
      if (!matches(a, preview.inputs[0]) || !matches(b, preview.inputs[1])) {
        previews.delete(previewId);
        return failure('MATERIAL_CONSUMED', '素材状态已变化，请重新预览后再确认', 'preview');
      }
      const output = preview.output;
      state.hand = state.hand.filter((c) => c.id !== a!.id && c.id !== b!.id);
      state.hand.push(output);
      previews.delete(previewId);
      return { ok: true, value: { card: output, token: cloneTokenAfterBump() } };
    },
  };
}

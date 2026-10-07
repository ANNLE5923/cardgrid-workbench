/**
 * A5 formal adapter: presents the IndexedDB-backed V06Host through the same
 * CatalogEditorHost surface the A2/A3 UI already consumes. This IS persistence:
 * every mutation is a named V06 command submitted to the host inside its atomic
 * transaction; results are read back from the post-commit snapshot, never from a
 * local copy. A failed submit is reported as failed (no fake success), and a
 * 'same-command' retry reuses the same command id so a lost response is not
 * applied twice. The decision flow is delegated to the formal decision session.
 */
import type {
  ActionCardV5,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  Deck,
  FieldResolution,
  HandCard,
  LiveView,
  SubmitV06Value,
  SynthesisPreview,
  UnifiedHandItem,
  V06Result,
} from '../workspace/v06.ts';
import { createV06DecisionSession } from '../workspace/v06.ts';
import type { Id, Token, VersionRef, V06Host } from '../workspace/index.ts';
import type { V06Command } from '../workspace/v06.ts';
import type {
  CatalogEditorHost,
  DecisionCandidatesView,
  DecisionDrawPreview,
  DrawChoice,
  EditorResult,
  MoveMemberInput,
  SaveEntityInput,
} from './catalog-editor.ts';

type DecisionSession = ReturnType<typeof createV06DecisionSession>;
type Loaded = Readonly<{ token: Token; data: import('../workspace/v06.ts').DataV5 }>;

const fail = (
  code: import('../workspace/v06.ts').V06ErrorCode,
  message: string,
  retry: 'edit' | 'preview' | 'reload' | 'same-command' | 'none',
  field?: string,
): EditorResult<never> => ({ ok: false, code, message, retry, ...(field ? { field } : {}) });

// Stable per-command signature for same-command replay (key order is fixed here).
const signatureOf = (command: V06Command): string =>
  JSON.stringify({ type: command.type, payload: command.payload });

export function createFormalCatalogEditor(
  host: V06Host,
  options: Readonly<{ id?: () => Id }> = {},
): CatalogEditorHost {
  const newId = options.id ?? (() => crypto.randomUUID());
  const decision: DecisionSession = createV06DecisionSession(host);
  let pending: Readonly<{ command: V06Command; signature: string }> | null = null;

  const load = async (): Promise<EditorResult<Loaded>> => {
    const r = await host.loadV5();
    if (!r.ok) return r;
    if (pending && pending.command.expected.epoch !== r.value.token.epoch) {
      pending = null;
      return fail('WORKSPACE_REPLACED', '工作区已恢复，请刷新后重新操作', 'reload');
    }
    return { ok: true, value: { token: r.value.token, data: r.value.data } };
  };

  const reload = async (
    expectedEpoch: string,
  ): Promise<
    EditorResult<Readonly<{ token: Token; catalog: CatalogV06; cards: readonly HandCard[] }>>
  > => {
    const s = await load();
    if (!s.ok) return s;
    if (s.value.token.epoch !== expectedEpoch)
      return fail('WORKSPACE_REPLACED', '工作区已恢复，请刷新后重新操作', 'reload');
    const [catalog, materials] = await Promise.all([
      host.readCatalog({ token: s.value.token }),
      host.readMaterials({ token: s.value.token }),
    ]);
    if (!catalog.ok) return catalog;
    if (!materials.ok) return materials;
    return {
      ok: true,
      value: { token: s.value.token, catalog: catalog.value.data, cards: materials.value.data },
    };
  };

  /** A save is confirmed only after its committed result has been read back.
   * Keep the original request across lost replies and read faults. Restoration
   * ends that request; it must never be replayed in the replacement workspace. */
  const execute = async <T>(
    command: V06Command,
    readCommitted: (receipt: SubmitV06Value, epoch: string) => Promise<EditorResult<T>>,
  ): Promise<EditorResult<T>> => {
    const signature = signatureOf(command);
    if (pending && pending.signature !== signature)
      return fail('STORAGE_FAILED', '上一保存结果尚未确认，请先重试原操作', 'same-command');
    if (!pending || pending.signature !== signature) pending = { command, signature };
    let r: V06Result<SubmitV06Value>;
    try {
      r = await host.submit(pending.command);
    } catch {
      return fail('STORAGE_FAILED', '保存结果尚未收到，请重试原操作', 'same-command');
    }
    if (!r.ok) {
      if (r.retry !== 'same-command') pending = null;
      return r;
    }
    try {
      const after = await readCommitted(r.value, command.expected.epoch);
      if (!after.ok) {
        if (after.code === 'WORKSPACE_REPLACED') {
          pending = null;
          return { ...after, retry: 'reload' };
        }
        return { ...after, retry: 'same-command' };
      }
      pending = null;
      return after;
    } catch {
      return fail('STORAGE_FAILED', '保存结果尚未完整读回，请重试原操作', 'same-command');
    }
  };

  type CollectionKey = 'actionCards' | 'catalogEntries' | 'decks' | 'decisionCards';
  const saveOne = async (
    collectionKey: CollectionKey,
    draft: Readonly<{ id: Id; version: number }>,
    expectedVersion: number | null,
    commandType: 'SaveActionCardV5' | 'SaveCatalogEntry' | 'SaveDeck' | 'SaveDecisionCard',
    payloadKey: 'actionCard' | 'entry' | 'deck' | 'decision',
  ): Promise<EditorResult<Readonly<{ saved: unknown; token: Token }>>> => {
    const s = await load();
    if (!s.ok) return s;
    // Replay an uncertain save before checking the current entity head: the
    // prior command may have committed even when its reply was lost.
    const pendingPayload = pending?.command.payload as Record<string, unknown> | undefined;
    const retrying =
      pending?.command.type === commandType &&
      pendingPayload?.expectedVersion === expectedVersion &&
      JSON.stringify({
        ...draft,
        version: (pendingPayload?.[payloadKey] as { version?: number })?.version,
      }) === JSON.stringify(pendingPayload?.[payloadKey]);
    let command: V06Command;
    if (pending) {
      if (!retrying)
        return fail('STORAGE_FAILED', '上一保存结果尚未确认，请先重试原操作', 'same-command');
      command = pending.command;
    } else {
      const collection = s.value.data[collectionKey] as readonly Readonly<{
        id: Id;
        version: number;
      }>[];
      const existing = collection.find((item) => item.id === draft.id);
      if (!existing && expectedVersion !== null)
        return fail('INVALID_INPUT', '新建对象的期望版本必须为空', 'edit');
      if (existing && expectedVersion === null)
        return fail('INVALID_INPUT', '已存在对象需提供期望版本', 'edit');
      if (existing && existing.version !== expectedVersion)
        return fail('REVISION_CONFLICT', '该对象已被其他操作修改，请刷新后重试', 'reload');
      const saved = { ...draft, version: existing ? existing.version + 1 : 1 };
      command = {
        contractVersion: 'v06-p0-1',
        commandId: newId(),
        expected: s.value.token,
        type: commandType,
        payload: { [payloadKey]: saved, expectedVersion: existing ? existing.version : null },
      } as unknown as V06Command;
    }
    return execute<Readonly<{ saved: unknown; token: Token }>>(command, async (_receipt, epoch) => {
      const after = await reload(epoch);
      if (!after.ok) return after;
      const fresh = (after.value.catalog[collectionKey] as readonly Readonly<{ id: Id }>[]).find(
        (item) => item.id === draft.id,
      );
      if (!fresh)
        return fail('STORAGE_FAILED', '保存回执未在当前数据中读回，请重试原请求', 'same-command');
      return { ok: true, value: { saved: fresh, token: after.value.token } };
    });
  };

  /** Read back the single hand card named by the submit receipt. */
  const readBackCard = async (
    receipt: SubmitV06Value,
    epoch: string,
    match: (card: HandCard) => boolean,
  ): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>> => {
    const after = await reload(epoch);
    if (!after.ok) return after;
    const refIds = new Set(
      receipt.resultRefs.filter((r) => r.kind === 'hand-card').map((r) => r.id),
    );
    const card = after.value.cards.find((c) => refIds.has(c.id) && match(c));
    if (!card) return fail('STORAGE_FAILED', '保存回执未完整读回，请重试原请求', 'same-command');
    return { ok: true, value: { card, token: after.value.token } };
  };

  return {
    stamp: { contractVersion: 'v06-p0-1', backend: 'formal', release: 'draft' },

    async readCatalog(): Promise<EditorResult<LiveView<CatalogV06>>> {
      const s = await load();
      if (!s.ok) return s;
      return host.readCatalog({ token: s.value.token });
    },

    async readHand(): Promise<EditorResult<LiveView<readonly UnifiedHandItem[]>>> {
      const s = await load();
      if (!s.ok) return s;
      const materials = await host.readMaterials({ token: s.value.token });
      if (!materials.ok) return materials;
      // "Current hand" means materials still usable today. readMaterials keeps
      // consumed/placed/expired records for history; exclude them so the hand
      // count matches the in-memory host semantics after synthesis/take.
      const data: readonly UnifiedHandItem[] = materials.value.data
        .filter((card) => card.state === 'available')
        .map((card) => ({ card, usableInToday: true, unavailableReason: null }));
      return { ok: true, value: { access: 'live', token: materials.value.token, data } };
    },

    async saveEntry(input: SaveEntityInput<CatalogEntry>) {
      const r = await saveOne(
        'catalogEntries',
        input.draft,
        input.expectedVersion,
        'SaveCatalogEntry',
        'entry',
      );
      if (!r.ok) return r;
      return { ok: true, value: { entry: r.value.saved as CatalogEntry, token: r.value.token } };
    },

    async saveAction(input: SaveEntityInput<ActionCardV5>) {
      const r = await saveOne(
        'actionCards',
        input.draft,
        input.expectedVersion,
        'SaveActionCardV5',
        'actionCard',
      );
      if (!r.ok) return r;
      return { ok: true, value: { action: r.value.saved as ActionCardV5, token: r.value.token } };
    },

    async saveDeck(input: SaveEntityInput<Deck>) {
      const r = await saveOne('decks', input.draft, input.expectedVersion, 'SaveDeck', 'deck');
      if (!r.ok) return r;
      return { ok: true, value: { deck: r.value.saved as Deck, token: r.value.token } };
    },

    async saveDecision(input: SaveEntityInput<DecisionCard>) {
      const r = await saveOne(
        'decisionCards',
        input.draft,
        input.expectedVersion,
        'SaveDecisionCard',
        'decision',
      );
      if (!r.ok) return r;
      return { ok: true, value: { decision: r.value.saved as DecisionCard, token: r.value.token } };
    },

    async moveMember(input: MoveMemberInput) {
      if (!Number.isSafeInteger(input.targetIndex) || input.targetIndex < 0)
        return fail('INVALID_INPUT', '目标位置必须是不小于 0 的整数', 'edit');
      const s = await load();
      if (!s.ok) return s;
      const command = {
        contractVersion: 'v06-p0-1',
        commandId: newId(),
        expected: s.value.token,
        type: 'MoveDeckMember',
        payload: {
          entry: input.entry,
          from: input.from,
          to: input.to,
          targetIndex: input.targetIndex,
        },
      } as unknown as V06Command;
      return execute(command, async (_receipt, epoch) => {
        const after = await reload(epoch);
        if (!after.ok) return after;
        return { ok: true, value: { token: after.value.token } };
      });
    },

    async takeAction(input: Readonly<{ action: VersionRef }>) {
      const s = await load();
      if (!s.ok) return s;
      const command = {
        contractVersion: 'v06-p0-1',
        commandId: newId(),
        expected: s.value.token,
        type: 'TakeActionMaterial',
        payload: { action: input.action },
      } as unknown as V06Command;
      return execute(command, (receipt, epoch) =>
        readBackCard(receipt, epoch, (c) => c.kind === 'action'),
      );
    },

    async takeEntry(input: Readonly<{ entry: VersionRef }>) {
      const s = await load();
      if (!s.ok) return s;
      const command = {
        contractVersion: 'v06-p0-1',
        commandId: newId(),
        expected: s.value.token,
        type: 'TakeEntryMaterial',
        payload: { entry: input.entry },
      } as unknown as V06Command;
      return execute(command, (receipt, epoch) =>
        readBackCard(receipt, epoch, (c) => c.kind === 'entry'),
      );
    },

    // Formal answer materials are produced only by accepting a decision draw.
    async stageAnswerMaterial(): Promise<EditorResult<Readonly<{ card: HandCard; token: Token }>>> {
      return fail(
        'CONTRACT_NOT_IMPLEMENTED',
        '正式流程请通过决策会话「接受答案」生成答案素材',
        'edit',
      );
    },

    async previewSynthesis(
      input: Readonly<{
        inputs: readonly [VersionRef, VersionRef];
        resolutions: readonly FieldResolution[];
      }>,
    ): Promise<V06Result<SynthesisPreview>> {
      const s = await load();
      if (!s.ok) return s;
      return host.previewSynthesis({
        token: s.value.token,
        inputs: input.inputs as readonly [
          { id: string; version: number },
          { id: string; version: number },
        ],
        resolutions: input.resolutions,
      });
    },

    async confirmSynthesis(input: Readonly<{ previewId: Id }>) {
      const s = await load();
      if (!s.ok) return s;
      const command = {
        contractVersion: 'v06-p0-1',
        commandId: newId(),
        expected: s.value.token,
        type: 'ConfirmSynthesis',
        payload: { previewId: input.previewId },
      } as unknown as V06Command;
      return execute(command, (receipt, epoch) =>
        readBackCard(receipt, epoch, (c) => c.kind === 'composite'),
      );
    },

    // Decision flow delegated verbatim to the formal decision session.
    listDecisionCandidates(
      input: Readonly<{ decision: VersionRef }>,
    ): Promise<V06Result<DecisionCandidatesView>> {
      return decision.listDecisionCandidates(input);
    },
    previewDecisionDraw(
      input: Readonly<{ decision: VersionRef; choice: DrawChoice }>,
    ): Promise<V06Result<DecisionDrawPreview>> {
      return decision.previewDecisionDraw(input);
    },
    acceptDecisionAnswer(
      input: Readonly<{
        decision: VersionRef;
        entry: VersionRef;
        alsoTakeAction: boolean;
      }>,
    ) {
      return decision.acceptDecisionAnswer(input);
    },
  };
}

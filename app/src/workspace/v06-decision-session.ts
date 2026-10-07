/** B5 formal decision session. Draft capabilities and retry identity stay here;
 * only the named Host command persists cards. The session owns no workspace copy. */
import type { V06Host } from './v06-host.ts';
import type { Token, VersionRef } from './contracts.ts';
import type {
  DataV5,
  DecisionPreview,
  SelectedAnswer,
  V06Result,
  HandCard,
} from './contracts-v06.ts';
import type { V06Command } from './ports-v06.ts';
import type {
  DecisionSessionPort,
  DecisionDrawPreview,
  AcceptDecisionAnswerResult,
} from '../decision/ui/index.ts';

type Host = Pick<
  V06Host,
  | 'loadV5'
  | 'readDecisionCandidates'
  | 'previewDecision'
  | 'selectDecisionEntry'
  | 'cancelPreview'
  | 'readMaterials'
  | 'submit'
>;
const sameRef = (a: VersionRef, b: VersionRef) => a.id === b.id && a.version === b.version;
const sameToken = (a: Token, b: Token) => a.epoch === b.epoch && a.revision === b.revision;
const fail = (
  code:
    | 'PREVIEW_STALE'
    | 'REVISION_CONFLICT'
    | 'WORKSPACE_REPLACED'
    | 'ENTRY_STALE'
    | 'INVALID_INPUT'
    | 'STORAGE_FAILED'
    | 'UNSUPPORTED_VERSION',
  message: string,
  retry: 'none' | 'reload' | 'preview' | 'same-command' = 'preview',
): Extract<V06Result<unknown>, { ok: false }> => ({ ok: false, code, message, retry });

export function createV06DecisionSession(host: Host, options: { id?: () => string } = {}) {
  const id = options.id ?? (() => crypto.randomUUID());
  let draft: {
    preview: DecisionPreview;
    selected: SelectedAnswer;
    view: DecisionDrawPreview;
    deckIds: readonly string[];
  } | null = null;
  let pending: V06Command | null = null,
    accepted: {
      decision: VersionRef;
      entry: VersionRef;
      withAction: boolean;
      value: AcceptDecisionAnswerResult;
    } | null = null;
  let locked = false,
    closed = false,
    reads = Promise.resolve(),
    idle = Promise.resolve(),
    release: (() => void) | undefined;
  async function run<T>(fn: () => Promise<V06Result<T>>): Promise<V06Result<T>> {
    if (closed) return fail('PREVIEW_STALE', '会话已关闭', 'none');
    if (locked) return fail('PREVIEW_STALE', '正在处理本次选择，请稍候', 'none');
    locked = true;
    idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await fn();
    } catch (error) {
      return fail(
        'STORAGE_FAILED',
        error instanceof Error ? error.message : '读取或保存失败',
        pending ? 'same-command' : 'reload',
      );
    } finally {
      locked = false;
      release?.();
      release = undefined;
    }
  }
  // Navigation or a fast question switch can supersede an in-flight read.
  // Drain reads in order; business accepts still reject concurrent writes.
  function read<T>(fn: () => Promise<V06Result<T>>): Promise<V06Result<T>> {
    const result = reads.then(async () => {
      while (locked) await idle;
      return run(fn);
    });
    reads = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function current(): Promise<V06Result<{ token: Token; data: DataV5 }>> {
    const prior = draft?.preview.token ?? pending?.expected;
    const r = await host.loadV5({ epoch: prior?.epoch });
    if (!r.ok && r.code === 'WORKSPACE_REPLACED') {
      draft = null;
      pending = null;
      accepted = null;
    }
    return r;
  }
  async function invalidateDraft() {
    if (draft)
      await host.cancelPreview({ token: draft.preview.token, previewId: draft.preview.previewId });
    draft = null;
    accepted = null;
  }
  async function checkDraft(): Promise<V06Result<NonNullable<typeof draft>>> {
    if (!draft) return fail('PREVIEW_STALE', '请先明确抽取或手选一个答案');
    const r = await current();
    if (!r.ok) return r;
    if (!sameToken(draft!.preview.token, r.value.token)) {
      await invalidateDraft();
      return fail('REVISION_CONFLICT', '工作区已更新，请重新选择答案', 'reload');
    }
    return { ok: true, value: draft! };
  }
  const session: DecisionSessionPort & {
    readonly stamp: Readonly<{ contractVersion: 'v06-p0-1'; backend: 'formal'; release: 'draft' }>;
    close: () => void;
  } = {
    stamp: Object.freeze({ contractVersion: 'v06-p0-1', backend: 'formal', release: 'draft' }),
    listDecisionCandidates: (input) =>
      read(async () => {
        if (pending) {
          const r = await current();
          if (!r.ok) return r;
          if (draft && sameRef(draft.preview.decision, input.decision))
            return {
              ok: true,
              value: {
                decision: structuredClone(input.decision),
                candidates: structuredClone(draft.view.candidates),
                sourceDeckIds: [...draft.deckIds],
              },
            };
          return fail('PREVIEW_STALE', '上次保存结果尚未确认，请重试原操作', 'same-command');
        }
        const r = await current();
        if (!r.ok) return r;
        const decision = r.value.data.decisionCards.find((d) => sameRef(d, input.decision));
        if (!decision) return fail('ENTRY_STALE', '决策原卡已变化，请重新读取', 'reload');
        if (
          draft &&
          (!sameRef(draft.preview.decision, input.decision) ||
            !sameToken(draft.preview.token, r.value.token))
        )
          await invalidateDraft();
        const candidates = await host.readDecisionCandidates({
          token: r.value.token,
          decision: input.decision,
          deckIds: decision.deckIds,
        });
        if (!candidates.ok) return candidates;
        return {
          ok: true,
          value: {
            decision: structuredClone(input.decision),
            candidates: candidates.value.candidates.map((e) => ({
              entry: { id: e.id, version: e.version },
              title: e.title,
            })),
            sourceDeckIds: [...decision.deckIds],
          },
        };
      }),
    readDecisionDraw: (input) =>
      read(async () => {
        if (!draft || !sameRef(draft.preview.decision, input.decision) || accepted)
          return { ok: true, value: null };
        if (pending) {
          const r = await current();
          return r.ok ? { ok: true, value: structuredClone(draft!.view) } : r;
        }
        const r = await checkDraft();
        return r.ok ? { ok: true, value: structuredClone(r.value.view) } : r;
      }),
    previewDecisionDraw: (input) =>
      run(async () => {
        if (pending)
          return fail('PREVIEW_STALE', '上次保存结果尚未确认，请重试原操作', 'same-command');
        const r = await current();
        if (!r.ok) return r;
        const decision = r.value.data.decisionCards.find((d) => sameRef(d, input.decision));
        if (!decision) return fail('ENTRY_STALE', '决策原卡已变化', 'reload');
        await invalidateDraft();
        const preview = await host.previewDecision({
          token: r.value.token,
          decision: input.decision,
          deckIds: decision.deckIds,
        });
        if (!preview.ok) return preview;
        const selected = await host.selectDecisionEntry({
          token: preview.value.token,
          previewId: preview.value.previewId,
          choice:
            input.choice.kind === 'random'
              ? { mode: 'random' }
              : { mode: 'manual', entry: input.choice.entry },
        });
        if (!selected.ok) {
          await host.cancelPreview({
            token: preview.value.token,
            previewId: preview.value.previewId,
          });
          return selected;
        }
        const view: DecisionDrawPreview = {
          decision: preview.value.decision,
          candidates: preview.value.candidates.map((e) => ({
            entry: { id: e.id, version: e.version },
            title: e.title,
          })),
          selected: selected.value.answer,
          sourceFingerprint: preview.value.sourceFingerprint,
        };
        if (closed) {
          await host.cancelPreview({
            token: preview.value.token,
            previewId: preview.value.previewId,
          });
          return fail('PREVIEW_STALE', '会话已关闭', 'none');
        }
        draft = {
          preview: preview.value,
          selected: selected.value,
          view,
          deckIds: [...decision.deckIds],
        };
        return { ok: true, value: structuredClone(view) };
      }),
    cancelDecisionDraw: () =>
      run(async () => {
        if (pending)
          return fail(
            'PREVIEW_STALE',
            '上次保存结果尚未确认，请先重试；取消不能撤销已提交记录',
            'same-command',
          );
        await invalidateDraft();
        return { ok: true, value: { cancelled: true as const } };
      }),
    acceptDecisionAnswer: (input) =>
      run(async () => {
        if (accepted) {
          const live = await host.loadV5({ epoch: accepted.value.token.epoch });
          if (!live.ok) {
            accepted = null;
            return live;
          }
          if (
            sameRef(input.decision, accepted.decision) &&
            sameRef(input.entry, accepted.entry) &&
            input.alsoTakeAction === accepted.withAction
          )
            return { ok: true, value: structuredClone(accepted.value) };
          return fail('PREVIEW_STALE', '此选择已接受；再次拿牌请明确重新选择');
        }
        if (pending) {
          if (
            pending.type !== 'AcceptDecisionAnswer' ||
            !draft ||
            !sameRef(input.decision, draft.preview.decision) ||
            !sameRef(input.entry, draft.selected.answer.entry) ||
            pending.payload.alsoTakeAction !== input.alsoTakeAction
          )
            return fail('PREVIEW_STALE', '请按原选择和拿牌方式重试本次保存', 'same-command');
        } else {
          const r = await checkDraft();
          if (!r.ok) return r;
          if (
            !sameRef(input.decision, r.value.preview.decision) ||
            !sameRef(input.entry, r.value.selected.answer.entry)
          )
            return fail('INVALID_INPUT', '只能接受本次已展示的确切答案');
          pending = {
            contractVersion: 'v06-p0-1',
            commandId: id(),
            expected: r.value.preview.token,
            type: 'AcceptDecisionAnswer',
            payload: {
              selectionId: r.value.selected.selectionId,
              alsoTakeAction: input.alsoTakeAction,
            },
          };
        }
        const command = pending,
          result = await host.submit(command);
        if (!result.ok) {
          if (result.retry !== 'same-command') {
            pending = null;
            await invalidateDraft();
          }
          return result;
        }
        const live = await current();
        if (!live.ok) return live;
        if (live.value.token.epoch !== command.expected.epoch) {
          pending = null;
          draft = null;
          return fail('WORKSPACE_REPLACED', '保存后工作区已被替换，请重新读取', 'reload');
        }
        const ids = result.value.resultRefs.filter((r) => r.kind === 'hand-card').map((r) => r.id),
          cards = live.value.data.handCards.filter((c) => ids.includes(c.id));
        const answer = cards.find((c) => c.kind === 'answer'),
          action = cards.find((c) => c.kind === 'action') ?? null;
        if (!answer || input.alsoTakeAction !== Boolean(action))
          return fail('STORAGE_FAILED', '保存回执尚未完整读回，请重试原请求', 'same-command');
        const value: AcceptDecisionAnswerResult = {
          answer: structuredClone(answer as HandCard),
          action: structuredClone(action),
          token: live.value.token,
        };
        accepted = {
          decision: structuredClone(input.decision),
          entry: structuredClone(input.entry),
          withAction: input.alsoTakeAction,
          value,
        };
        pending = null;
        return { ok: true, value: structuredClone(value) };
      }),
    close() {
      closed = true;
      if (draft && !pending)
        void host.cancelPreview({ token: draft.preview.token, previewId: draft.preview.previewId });
      draft = null;
      accepted = null;
    },
  };
  return session;
}
export type V06DecisionSession = ReturnType<typeof createV06DecisionSession>;

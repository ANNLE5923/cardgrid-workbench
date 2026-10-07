// A2 workshop editor (v0.6 generic catalog). The matrix manages decks, entries,
// member moves and decision ownership, and offers direct material take. All
// mutations go through the injected CatalogEditorHost (an in-memory adapter in
// this milestone; the real Host ships in B4). Drafts, errors, empty lists and
// save state are explained inline; nothing claims durable persistence.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionCard } from '../../../shared/ui/index.ts';
import type {
  ActionCardV5,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  Deck,
} from '../../../workspace/v06.ts';
import type { Id, VersionRef } from '../../../workspace/index.ts';
import type { CatalogEditorHost, EditorResult } from '../../catalog-editor.ts';
import { DeckForm, EntryForm, DecisionForm } from './EditorForms.tsx';
import { ActionForm } from './ActionForm.tsx';
import { SynthesisBenchV06 } from './SynthesisBenchV06.tsx';
import './workshop-editor-v06.css';

type View =
  | { type: 'matrix' }
  | { type: 'deck-form'; id?: Id }
  | { type: 'entry-form'; id?: Id; deckId?: Id }
  | { type: 'action-form'; id?: Id }
  | { type: 'decision-form'; id?: Id }
  | { type: 'members'; id: Id }
  | { type: 'synthesis' };

const kindLabel = (kind: Deck['deckKind']) =>
  kind === 'entry' ? '资源' : kind === 'action' ? '行动' : '决策';

type AnyMember = CatalogEntry | ActionCardV5 | DecisionCard;
const membersOf = (cat: CatalogV06, deck: Deck): AnyMember[] =>
  deck.memberIds
    .map((id) =>
      deck.deckKind === 'entry'
        ? cat.catalogEntries.find((e) => e.id === id)
        : deck.deckKind === 'action'
          ? cat.actionCards.find((a) => a.id === id)
          : cat.decisionCards.find((d) => d.id === id),
    )
    .filter((x): x is AnyMember => x !== undefined);
const memberLabel = (member: AnyMember, kind: Deck['deckKind']): string =>
  kind === 'entry'
    ? (member as CatalogEntry).title
    : kind === 'action'
      ? (member as ActionCardV5).content.title
      : (member as DecisionCard).question;
const memberVersion = (member: AnyMember): number => member.version;

export type WorkshopEditorV06Props = Readonly<{
  host: CatalogEditorHost;
  onOpenListUrl?: (entry: CatalogEntry) => void;
}>;

export function WorkshopEditorV06({ host, onOpenListUrl }: WorkshopEditorV06Props) {
  const [catalog, setCatalog] = useState<CatalogV06 | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ type: 'matrix' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [handCount, setHandCount] = useState(0);
  const joining = useRef<{ member: { id: Id; title: string }; deck: Deck } | null>(null);

  const refresh = useCallback(async () => {
    const r = await host.readCatalog();
    if (r.ok) setCatalog(r.value.data);
    else setLoadError(r.message);
    const h = await host.readHand();
    if (h.ok) setHandCount(h.value.data.length);
  }, [host]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const goto = (next: View) => {
    setNotice(null);
    joining.current = null;
    setView(next);
  };

  const execute = async (
    fn: () => Promise<EditorResult<unknown>>,
    success: string,
    after?: () => void,
  ) => {
    setBusy(true);
    setNotice(null);
    let r: EditorResult<unknown>;
    try {
      r = await fn();
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : '保存未完成，请重试' });
      setBusy(false);
      return;
    }
    if (!r.ok) {
      setNotice({ tone: 'error', text: `（${r.code}）${r.message}` });
      setBusy(false);
      return;
    }
    await refresh();
    setBusy(false);
    // Navigate (which clears the notice) first, then show success so a saved
    // form still gives visible feedback after returning to the matrix.
    after?.();
    setNotice({ tone: 'success', text: success });
  };

  if (loadError)
    return (
      <div className="we2-load-error" role="alert">
        工坊加载失败：{loadError}
      </div>
    );
  if (!catalog) return <div className="we2-loading">工坊加载中…</div>;

  const submitMember = async (
    input: { kind: 'entry'; draft: CatalogEntry } | { kind: 'action'; draft: ActionCardV5 },
    expectedVersion: number | null,
    targetDeckId: Id | null,
  ) => {
    const { draft } = input;
    const title = input.kind === 'entry' ? input.draft.title : input.draft.content.title;
    const label = input.kind === 'entry' ? '条目' : '行动';
    const join = async (step: {
      member: { id: Id; title: string };
      deck: Deck;
    }): Promise<EditorResult<unknown>> => {
      const result = await host.saveDeck({ draft: step.deck, expectedVersion: step.deck.version });
      if (!result.ok) {
        if (result.retry === 'reload') {
          const latest = await host.readCatalog();
          if (latest.ok) {
            const deck = latest.value.data.decks.find((d) => d.id === step.deck.id);
            if (deck)
              joining.current = {
                member: step.member,
                deck: {
                  ...deck,
                  memberIds: deck.memberIds.includes(step.member.id)
                    ? deck.memberIds
                    : [...deck.memberIds, step.member.id],
                },
              };
          }
        }
        return {
          ...result,
          message: `${label}「${step.member.title}」已保存，加入牌堆未完成。再次点击创建${label}只重试加入牌堆。${result.message}`,
        };
      }
      joining.current = null;
      return result;
    };
    const run = async (): Promise<EditorResult<unknown>> => {
      if (joining.current) {
        const step = joining.current;
        // The entry has already committed. Retry only the failed membership
        // command, with its original payload and command capability.
        if (step.member.id !== draft.id || targetDeckId !== step.deck.id)
          return {
            ok: false,
            code: 'INVALID_INPUT',
            message: '条目已保存，请先重试加入原牌堆',
            retry: 'edit',
          };
        return join(step);
      }
      const saved =
        input.kind === 'entry'
          ? await host.saveEntry({ draft: input.draft, expectedVersion })
          : await host.saveAction({ draft: input.draft, expectedVersion });
      if (!saved.ok || !targetDeckId) return saved;
      const deck = catalog.decks.find((d) => d.id === targetDeckId);
      if (!deck) return saved;
      const updated: Deck = { ...deck, memberIds: [...deck.memberIds, draft.id] };
      joining.current = { member: { id: draft.id, title }, deck: updated };
      return join(joining.current);
    };
    await execute(run, `${label}「${title}」已保存${targetDeckId ? '并加入牌堆' : ''}`, () =>
      goto({ type: 'matrix' }),
    );
  };

  let body: React.ReactNode;
  if (view.type === 'deck-form') {
    const initial = view.id ? catalog.decks.find((d) => d.id === view.id) : undefined;
    body = (
      <DeckForm
        decks={catalog.decks}
        initial={initial}
        busy={busy}
        onCancel={() => goto({ type: 'matrix' })}
        onSubmit={(draft, expectedVersion) =>
          execute(
            () => host.saveDeck({ draft, expectedVersion }),
            `牌堆「${draft.name}」已保存`,
            () => goto({ type: 'matrix' }),
          )
        }
      />
    );
  } else if (view.type === 'entry-form') {
    const initial = view.id ? catalog.catalogEntries.find((e) => e.id === view.id) : undefined;
    body = (
      <EntryForm
        initial={initial}
        decks={catalog.decks}
        defaultDeckId={view.deckId ?? null}
        joinPending={joining.current !== null}
        busy={busy}
        onCancel={() => goto({ type: 'matrix' })}
        onSubmit={(draft, expectedVersion, deckId) =>
          submitMember({ kind: 'entry', draft }, expectedVersion, deckId)
        }
      />
    );
  } else if (view.type === 'action-form') {
    const initial = view.id ? catalog.actionCards.find((a) => a.id === view.id) : undefined;
    body = (
      <ActionForm
        initial={initial}
        decks={catalog.decks}
        busy={busy}
        joinPending={joining.current !== null}
        onCancel={() => goto({ type: 'matrix' })}
        onSubmit={(draft, expectedVersion, deckId) =>
          submitMember({ kind: 'action', draft }, expectedVersion, deckId)
        }
      />
    );
  } else if (view.type === 'decision-form') {
    const initial = view.id ? catalog.decisionCards.find((d) => d.id === view.id) : undefined;
    body = (
      <DecisionForm
        actions={catalog.actionCards}
        decks={catalog.decks}
        initial={initial}
        busy={busy}
        onCancel={() => goto({ type: 'matrix' })}
        onSubmit={(draft, expectedVersion) =>
          execute(
            () => host.saveDecision({ draft, expectedVersion }),
            `决策「${draft.question}」已保存`,
            () => goto({ type: 'matrix' }),
          )
        }
      />
    );
  } else if (view.type === 'members') {
    const deck = catalog.decks.find((d) => d.id === view.id);
    body = deck ? (
      <DeckMembersPanel
        onOpenListUrl={onOpenListUrl}
        catalog={catalog}
        deck={deck}
        busy={busy}
        host={host}
        onClose={() => goto({ type: 'matrix' })}
        onEditEntry={(id) => goto({ type: 'entry-form', id })}
        onEditAction={(id) => goto({ type: 'action-form', id })}
        onEditDecision={(id) => goto({ type: 'decision-form', id })}
        onChanged={async (text) => {
          await refresh();
          setNotice({ tone: 'success', text });
        }}
      />
    ) : null;
  } else if (view.type === 'synthesis') {
    body = (
      <SynthesisBenchV06
        host={host}
        onHandChanged={async () => {
          await refresh();
        }}
        onExit={() => goto({ type: 'matrix' })}
      />
    );
  } else {
    body = (
      <MatrixView
        catalog={catalog}
        busy={busy}
        handCount={handCount}
        host={host}
        onNewDeck={() => goto({ type: 'deck-form' })}
        onNewEntry={(deckId) => goto({ type: 'entry-form', deckId })}
        onNewDecision={() => goto({ type: 'decision-form' })}
        onNewAction={() => goto({ type: 'action-form' })}
        onEditAction={(id) => goto({ type: 'action-form', id })}
        onManage={(id) => goto({ type: 'members', id })}
        onEditDeck={(id) => goto({ type: 'deck-form', id })}
        onSynthesis={() => goto({ type: 'synthesis' })}
        onMaterialResult={async (r) => {
          await refresh();
          if (r.ok) setNotice({ tone: 'success', text: '已加入本次手牌' });
          else setNotice({ tone: 'error', text: `（${r.code}）${r.message}` });
        }}
      />
    );
  }

  const formal = host.stamp.backend === 'formal';
  return (
    <div className="we2">
      <div className="we2-banner" role="note">
        {formal ? (
          <>
            正式存储模式：改动通过具名命令保存到本机 IndexedDB，<strong>刷新后保留</strong>
            ；保存失败会明确提示，不会假成功。
          </>
        ) : (
          <>
            内存编辑模式：改动只存在于内存，<strong>刷新即丢失</strong>
            ，不写入正式存储；正式持久化在后续 Host 接入。
          </>
        )}
      </div>
      {notice ? (
        <div className={`we2-notice ${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}
      {body}
    </div>
  );
}

// --- Matrix -----------------------------------------------------------------
function MatrixView(
  props: Readonly<{
    catalog: CatalogV06;
    busy: boolean;
    handCount: number;
    host: CatalogEditorHost;
    onNewDeck: () => void;
    onNewEntry: (deckId?: Id) => void;
    onNewDecision: () => void;
    onManage: (id: Id) => void;
    onEditDeck: (id: Id) => void;
    onNewAction: () => void;
    onEditAction: (id: Id) => void;
    onSynthesis: () => void;
    onMaterialResult: (r: Awaited<ReturnType<CatalogEditorHost['takeAction']>>) => Promise<void>;
  }>,
) {
  const { catalog, host, busy } = props;
  return (
    <>
      <div className="we2-toolbar">
        <div className="we2-toolbar-actions">
          <button type="button" className="we2-btn" disabled={busy} onClick={props.onNewDeck}>
            ＋ 新建牌堆
          </button>
          <button
            type="button"
            className="we2-btn"
            disabled={busy}
            onClick={() => props.onNewEntry()}
          >
            ＋ 新建条目
          </button>
          <button type="button" className="we2-btn" disabled={busy} onClick={props.onNewDecision}>
            ＋ 新建决策
          </button>
          <button type="button" className="we2-btn" disabled={busy} onClick={props.onNewAction}>
            ＋ 新建行动
          </button>
          <button
            type="button"
            className="we2-btn we2-btn-accent"
            disabled={busy}
            onClick={props.onSynthesis}
          >
            三槽合成台
          </button>
        </div>
        <details className="we2-hand">
          <summary>本次手牌：{props.handCount} 张</summary>
          <HandSummary host={host} handCount={props.handCount} />
        </details>
      </div>

      {catalog.decks.length === 0 ? (
        <div className="we2-empty-state">
          还没有牌堆。点击“新建牌堆”开始，或先新建条目再加入牌堆。
        </div>
      ) : (
        <div className="we2-grid">
          {catalog.decks.map((deck) => {
            const members = membersOf(catalog, deck);
            const preview = members.slice(0, 3);
            const parents = deck.parentDeckId
              ? catalog.decks.filter((d) => d.id === deck.parentDeckId)
              : [];
            const usedBy = catalog.decisionCards.filter((d) => d.deckIds.includes(deck.id));
            return (
              <ActionCard
                key={deck.id}
                color="var(--accent)"
                title={deck.name}
                meta={`${deck.memberIds.length} 个成员`}
                badges={[
                  {
                    id: 'kind',
                    label: kindLabel(deck.deckKind),
                    tone: usedBy.length ? 'on' : undefined,
                  },
                ]}
                footer={
                  <>
                    <button
                      type="button"
                      className="act-mini"
                      disabled={busy}
                      onClick={() => props.onManage(deck.id)}
                    >
                      管理成员
                    </button>
                    <button
                      type="button"
                      className="act-mini"
                      disabled={busy}
                      onClick={() => props.onEditDeck(deck.id)}
                    >
                      编辑牌堆
                    </button>
                    {deck.deckKind === 'action' && members[0] ? (
                      <button
                        type="button"
                        className="act-mini primary"
                        disabled={busy}
                        onClick={async () => {
                          const r = await host.takeAction({
                            action: { id: members[0].id, version: members[0].version },
                          });
                          await props.onMaterialResult(r);
                        }}
                      >
                        直接拿牌：{memberLabel(members[0], 'action')}
                      </button>
                    ) : null}
                  </>
                }
              >
                <div className="we2-binding">
                  {parents.length ? (
                    <span>父牌堆：{parents[0].name}</span>
                  ) : usedBy.length ? (
                    <span>决策候选：{usedBy.map((d) => d.question).join('、')}</span>
                  ) : (
                    <span className="we2-muted">未绑定 · 可作纯清单</span>
                  )}
                </div>
                <ul className="we2-preview">
                  {preview.map((m) => (
                    <li key={m.id}>{memberLabel(m, deck.deckKind)}</li>
                  ))}
                  {members.length > preview.length ? (
                    <li className="we2-muted">＋{members.length - preview.length} 条…</li>
                  ) : null}
                  {members.length === 0 ? <li className="we2-muted">（空牌堆）</li> : null}
                </ul>
              </ActionCard>
            );
          })}
        </div>
      )}
      <section aria-label="行动原库">
        <h2>行动原库</h2>
        {catalog.actionCards.length === 0 ? (
          <p className="we2-empty">还没有行动卡，可从上方新建。</p>
        ) : (
          <div className="we2-grid">
            {catalog.actionCards.map((action) => (
              <ActionCard
                key={action.id}
                color={action.content.color}
                title={action.content.title}
                meta={`v${action.version} · ${action.status === 'active' ? '启用' : action.status === 'paused' ? '暂停' : '归档'}`}
                footer={
                  <button
                    type="button"
                    className="act-mini"
                    disabled={busy}
                    onClick={() => props.onEditAction(action.id)}
                  >
                    编辑行动
                  </button>
                }
              >
                <p>{action.content.criteria}</p>
              </ActionCard>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function HandSummary(props: Readonly<{ host: CatalogEditorHost; handCount: number }>) {
  const [items, setItems] = useState<readonly { id: Id; label: string }[]>([]);
  useEffect(() => {
    props.host.readHand().then((r) => {
      if (r.ok)
        setItems(r.value.data.map(({ card }) => ({ id: card.id, label: handCardLabel(card) })));
    });
  }, [props.host, props.handCount]);
  if (!items.length)
    return <p className="we2-empty">暂无手牌；从行动牌堆“直接拿牌”或在成员管理里拿取。</p>;
  return (
    <ul className="we2-hand-list">
      {items.map((i) => (
        <li key={i.id}>{i.label}</li>
      ))}
    </ul>
  );
}
const handCardLabel = (card: import('../../../workspace/v06.ts').HandCard): string => {
  if (card.kind === 'action' || card.kind === 'composite')
    return `行动：${card.contentSnapshot.title}`;
  if (card.kind === 'answer') return `答案：${card.answer.entry.title}`;
  return `条目：${card.entrySnapshot.title}`;
};

// --- Deck members panel -----------------------------------------------------
function DeckMembersPanel(
  props: Readonly<{
    catalog: CatalogV06;
    deck: Deck;
    busy: boolean;
    host: CatalogEditorHost;
    onOpenListUrl?: (entry: CatalogEntry) => void;
    onClose: () => void;
    onEditEntry: (id: Id) => void;
    onEditDecision: (id: Id) => void;
    onEditAction: (id: Id) => void;
    onChanged: (text: string) => Promise<void>;
  }>,
) {
  const { catalog, deck, host, busy } = props;
  const members = membersOf(catalog, deck);
  const otherDecks = catalog.decks.filter((d) => d.deckKind === deck.deckKind && d.id !== deck.id);
  const [moveTarget, setMoveTarget] = useState<Id | ''>(otherDecks[0]?.id ?? '');
  const [sourceDeckId, setSourceDeckId] = useState<Id | ''>(otherDecks[0]?.id ?? '');
  const [sourceMemberId, setSourceMemberId] = useState<Id | ''>('');
  const [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    inFlight = useRef(false);
  const unavailable = busy || working;
  const run = async (work: () => Promise<EditorResult<unknown>>, success: string) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setWorking(true);
    setError('');
    try {
      const r = await work();
      if (!r.ok) {
        setError(`（${r.code}）${r.message}`);
        return false;
      }
      await props.onChanged(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试');
      return false;
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };

  const deckRef = (): VersionRef => ({ id: deck.id, version: deck.version });
  const doReorder = async (id: Id, version: number, currentIndex: number, delta: number) => {
    await run(
      () =>
        host.moveMember({
          entry: { id, version },
          from: deckRef(),
          to: deckRef(),
          targetIndex: currentIndex + delta,
        }),
      '顺序已更新',
    );
  };
  const moveOut = async (member: AnyMember) => {
    if (!moveTarget) return;
    const target = catalog.decks.find((d) => d.id === moveTarget)!;
    await run(
      () =>
        host.moveMember({
          entry: { id: member.id, version: memberVersion(member) },
          from: deckRef(),
          to: { id: target.id, version: target.version },
          targetIndex: target.memberIds.length,
        }),
      `已移动到「${target.name}」`,
    );
  };
  const moveIn = async () => {
    if (!sourceDeckId || !sourceMemberId) return;
    const source = catalog.decks.find((d) => d.id === sourceDeckId)!;
    const moved = await run(
      () =>
        host.moveMember({
          entry: {
            id: sourceMemberId,
            version: membersOf(catalog, source).find((m) => m.id === sourceMemberId)!.version,
          },
          from: { id: source.id, version: source.version },
          to: deckRef(),
          targetIndex: deck.memberIds.length,
        }),
      '已从其他牌堆移入',
    );
    if (moved) setSourceMemberId('');
  };
  const take = async (member: AnyMember) => {
    await run(
      () =>
        deck.deckKind === 'action'
          ? host.takeAction({ action: { id: member.id, version: member.version } })
          : host.takeEntry({ entry: { id: member.id, version: member.version } }),
      '已加入本次手牌',
    );
  };

  const sourceDeck = sourceDeckId ? catalog.decks.find((d) => d.id === sourceDeckId) : undefined;
  const sourceMembers = sourceDeck ? membersOf(catalog, sourceDeck) : [];

  return (
    <div
      className="we2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${deck.name} 成员管理`}
    >
      <div className="we2-modal panel">
        {error && <p role="alert">{error}</p>}
        <div className="we2-modal-head">
          <div>
            <h2>{deck.name}</h2>
            <small>
              {kindLabel(deck.deckKind)}牌堆 · {deck.memberIds.length} 个成员
            </small>
          </div>
          <button type="button" aria-label="关闭" disabled={unavailable} onClick={props.onClose}>
            ×
          </button>
        </div>

        {members.length === 0 ? (
          <p className="we2-empty">
            此牌堆还没有成员。可在下方从其他牌堆移入，或关闭后新建条目并加入。
          </p>
        ) : (
          <ul className="we2-members">
            {members.map((member, i) => (
              <li key={member.id} className="we2-member">
                <div className="we2-member-info">
                  <strong>{memberLabel(member, deck.deckKind)}</strong>
                  <small>
                    v{member.version}
                    {(member as CatalogEntry).url ? ` · ${(member as CatalogEntry).url}` : ''}
                  </small>
                </div>
                <div className="we2-member-actions">
                  <button
                    type="button"
                    className="act-mini"
                    disabled={unavailable || i === 0}
                    onClick={() => doReorder(member.id, member.version, i, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="act-mini"
                    disabled={unavailable || i === members.length - 1}
                    onClick={() => doReorder(member.id, member.version, i, 1)}
                  >
                    下移
                  </button>
                  {deck.deckKind === 'entry' ? (
                    <button
                      type="button"
                      className="act-mini"
                      disabled={unavailable}
                      onClick={() => props.onEditEntry(member.id)}
                    >
                      编辑
                    </button>
                  ) : null}
                  {deck.deckKind === 'decision' ? (
                    <button
                      type="button"
                      className="act-mini"
                      disabled={unavailable}
                      onClick={() => props.onEditDecision(member.id)}
                    >
                      编辑
                    </button>
                  ) : null}
                  {deck.deckKind === 'action' ? (
                    <button
                      type="button"
                      className="act-mini"
                      disabled={unavailable}
                      onClick={() => props.onEditAction(member.id)}
                    >
                      编辑
                    </button>
                  ) : null}
                  {deck.deckKind === 'entry' && (member as CatalogEntry).url ? (
                    <button
                      type="button"
                      className="act-mini"
                      disabled={unavailable}
                      onClick={() =>
                        props.onOpenListUrl
                          ? props.onOpenListUrl(member as CatalogEntry)
                          : window.open((member as CatalogEntry).url!, '_blank', 'noopener')
                      }
                    >
                      打开网址
                    </button>
                  ) : null}
                  {deck.deckKind !== 'decision' ? (
                    <button
                      type="button"
                      className="act-mini primary"
                      disabled={unavailable}
                      onClick={() => take(member)}
                    >
                      拿牌
                    </button>
                  ) : null}
                  {otherDecks.length ? (
                    <button
                      type="button"
                      className="act-mini"
                      disabled={unavailable}
                      onClick={() => moveOut(member)}
                    >
                      移动到…
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {otherDecks.length ? (
          <div className="we2-move-bar">
            <div className="we2-move-group">
              <span>把所选“移动到…”的成员送往：</span>
              <select
                disabled={unavailable}
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value as Id | '')}
              >
                {otherDecks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="we2-move-group">
              <span>从其他牌堆移入：</span>
              <select
                disabled={unavailable}
                value={sourceDeckId}
                onChange={(e) => {
                  setSourceDeckId(e.target.value as Id | '');
                  setSourceMemberId('');
                }}
              >
                {otherDecks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select
                disabled={unavailable}
                value={sourceMemberId}
                onChange={(e) => setSourceMemberId(e.target.value as Id | '')}
              >
                <option value="">（选择成员）</option>
                {sourceMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {memberLabel(m, deck.deckKind)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="act-mini"
                disabled={unavailable || !sourceMemberId}
                onClick={moveIn}
              >
                移入
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { useRef, useState, useSyncExternalStore } from 'react';
import type { V06ActionSession } from '../v06-action-session.ts';
import { Sphere } from '../../shared/ui/index.ts';
import './production-draw.css';

export function V06ActionDrawPanel({
  drawing,
  onAccepted,
}: Readonly<{ drawing: V06ActionSession; onAccepted?: () => void }>) {
  const state = useSyncExternalStore(drawing.subscribe, drawing.getSnapshot),
    [open, setOpen] = useState(false),
    trigger = useRef<HTMLElement | null>(null);
  const disabled = state.busy || state.canRetry;
  const accept = async () => {
    const r = await drawing.accept();
    if (r.ok) {
      setOpen(false);
      onAccepted?.();
    }
  };
  return (
    <section className="panel production-draw" aria-label="通用行动牌堆抽卡">
      <h2>先决定做什么</h2>
      <p>勾选行动牌堆，选定一张并翻开，接受后加入本次手牌。</p>
      <fieldset disabled={disabled}>
        <legend>候选行动牌堆</legend>
        {state.decks.map((deck) => (
          <label key={deck.id}>
            <input
              type="checkbox"
              checked={state.deckIds.includes(deck.id)}
              onChange={(e) =>
                drawing.setDeckIds(
                  e.target.checked
                    ? [...state.deckIds, deck.id]
                    : state.deckIds.filter((id) => id !== deck.id),
                )
              }
            />
            {deck.name}
          </label>
        ))}
        {!state.decks.length && <p>还没有行动牌堆，可在工坊建立。</p>}
      </fieldset>
      <p>当前候选 {state.candidates.length} 张；共享成员只出现一次。</p>
      {state.message && <p role={state.error ? 'alert' : 'status'}>{state.message}</p>}
      {state.canRetry && (
        <button
          type="button"
          disabled={state.busy}
          onClick={async () => {
            const r = await drawing.retry();
            if (r.ok) {
              setOpen(false);
              onAccepted?.();
            }
          }}
        >
          重试本次保存
        </button>
      )}
      <div className="toolbar">
        <button
          type="button"
          disabled={disabled}
          onClick={async (e) => {
            trigger.current = e.currentTarget;
            if ((await drawing.openSphere()).ok) setOpen(true);
          }}
        >
          行动球面
        </button>
        <label>
          手选行动
          <select
            aria-label="手选行动"
            disabled={disabled || !['idle', 'shuffling'].includes(state.phase)}
            value={state.selected?.id ?? ''}
            onChange={(e) => drawing.present(e.target.value)}
          >
            <option value="">选择一张行动牌</option>
            {state.candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.content.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (drawing.cancel()) setOpen(false);
          }}
        >
          取消本次行动抽卡
        </button>
      </div>
      {!open && state.phase === 'presented' && (
        <button type="button" disabled={disabled} onClick={() => drawing.reveal()}>
          翻开行动
        </button>
      )}
      {!open && state.phase === 'revealed' && state.selected && (
        <div>
          <h3>{state.selected.content.title}</h3>
          <p>{state.selected.content.criteria}</p>
          <button type="button" disabled={disabled} onClick={() => void accept()}>
            接受行动，加入手牌
          </button>
        </div>
      )}
      {open && state.candidates.length > 0 && (
        <Sphere
          mode="draw"
          motionState={state.phase === 'saved' ? 'idle' : state.phase}
          presentedId={state.selected?.id ?? null}
          revealedId={state.phase === 'revealed' ? (state.selected?.id ?? null) : null}
          cards={state.candidates.map((a) => ({
            id: a.id,
            face: 'back',
            frontData: { title: a.content.title, subtitle: a.content.criteria },
          }))}
          returnFocus={trigger.current}
          onSelectCard={drawing.present}
          onReveal={drawing.reveal}
          onClose={() => {
            if (drawing.cancel()) setOpen(false);
          }}
          detail={
            state.phase === 'revealed' && (
              <button type="button" disabled={disabled} onClick={() => void accept()}>
                接受行动，加入手牌
              </button>
            )
          }
        />
      )}
    </section>
  );
}

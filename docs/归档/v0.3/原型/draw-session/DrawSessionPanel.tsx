import { useId } from 'react';
import { useDrawSession, type DrawSessionSource } from './use-draw-session.ts';
import type {
  ComboSelection, DailyCopy, Id, SlotSpec,
} from '../../../../../src/workspace/index.ts';

/**
 * B2 draw surface. This is a minimal card face whose props/state follow the C0.8
 * Sphere contract; A1's neutral Sphere replaces the presentational divs without
 * touching this session logic. Buttons carry the full keyboard path; Esc cancels.
 */
export function DrawSessionPanel({ source }: Readonly<{ source: DrawSessionSource }>) {
  const { session, actions, onKeyDown } = useDrawSession(source);
  const { phase, deck } = session;
  const baseId = useId();
  const started = deck.length > 0 || phase.kind !== 'shuffling';
  const revealedCopy: DailyCopy | null =
    phase.kind === 'revealed' ? deck.find(c => c.id === phase.copyId) ?? null : null;

  return (
    <section className="panel draw-session" aria-label="抽卡找建议">
      {!started ? (
        <div className="draw-actions">
          <button type="button" className="primary" onClick={actions.start}>抽卡找建议</button>
          <p className="draw-empty">从今天的每日副本里抽一张；翻面、填槽、取消都不会创建行动。</p>
        </div>
      ) : (
        <div className="draw-stage-inner" tabIndex={-1} onKeyDown={onKeyDown}>
          {(phase.kind === 'shuffling' || phase.kind === 'presented') && (
            <button
              type="button" className="card-face card-back"
              aria-label={phase.kind === 'shuffling' ? '洗牌中，点击或按回车停转' : '已停转，点击或按回车翻面'}
              onClick={actions.primary}>
              <span>{phase.kind === 'shuffling' ? '洗牌中…停转' : '已停转…翻面'}</span>
            </button>
          )}

          {phase.kind === 'revealed' && revealedCopy && (
            <div className="card-face card-front">
              <h3>{revealedCopy.contentSnapshot.title}</h3>
              <p>{revealedCopy.contentSnapshot.criteria || '未填写完成标准。'}</p>
              <div className="draw-actions">
                <button type="button" className="primary" onClick={actions.primary}>
                  {revealedCopy.slotSpecSnapshot.length ? '继续：组合填空' : '继续：接受'}
                </button>
              </div>
            </div>
          )}

          {phase.kind === 'combo' && (
            <ComboForm
              phase={phase} source={source} baseId={baseId}
              setSlotMode={actions.setSlotMode} rollSlot={actions.rollSlot}
              pickSlot={actions.pickSlot} setComposed={actions.setComposed} primary={actions.primary} />
          )}

          <div className="draw-actions">
            <button type="button" onClick={actions.cancel}>取消（不保存）</button>
          </div>
        </div>
      )}
    </section>
  );
}

type ComboFormProps = Readonly<{
  phase: Extract<ReturnType<typeof useDrawSession>['session']['phase'], { kind: 'combo' }>;
  source: DrawSessionSource; baseId: string;
  setSlotMode: (slotId: SlotSpec['id'], mode: 'random' | 'manual') => void;
  rollSlot: (slotId: SlotSpec['id'], poolId: Id) => void;
  pickSlot: (slotId: SlotSpec['id'], entryId: Id) => void;
  setComposed: (text: string) => void;
  primary: () => void;
}>;

function ComboForm({ phase, source, baseId, setSlotMode, rollSlot, pickSlot, setComposed, primary }: ComboFormProps) {
  const { copy, selections } = phase;
  return (
    <div className="combo-form">
      {copy.slotSpecSnapshot.length === 0 ? (
        <p>这张卡没有需要填的槽，可直接接受。</p>
      ) : (
        copy.slotSpecSnapshot.map(spec => (
          <SlotRow
            key={spec.id} spec={spec} selection={selections.find(s => s.slotId === spec.id)}
            entries={source.entriesForSlot(spec.poolId)} baseId={baseId}
            setSlotMode={setSlotMode} rollSlot={rollSlot} pickSlot={pickSlot} />
        ))
      )}

      <label className="combo-text">组合文字
        <textarea value={phase.composedText} rows={2} onChange={e => setComposed(e.target.value)}
          aria-label="组合文字，可微调" />
      </label>

      <div className="draw-actions">
        <button type="button" className="primary" disabled={!phase.ready} onClick={primary}>
          {phase.ready ? '接受，加入手牌' : '还有必填槽未填'}
        </button>
      </div>
    </div>
  );
}

type SlotRowProps = Readonly<{
  spec: SlotSpec;
  selection: ComboSelection | undefined;
  entries: ReturnType<DrawSessionSource['entriesForSlot']>;
  baseId: string;
  setSlotMode: ComboFormProps['setSlotMode'];
  rollSlot: ComboFormProps['rollSlot'];
  pickSlot: ComboFormProps['pickSlot'];
}>;

function SlotRow({ spec, selection, entries, baseId, setSlotMode, rollSlot, pickSlot }: SlotRowProps) {
  const active = entries.filter(e => e.status === 'active');
  const mode = selection?.mode ?? 'manual';
  const picked = selection?.entryId ? active.find(e => e.id === selection.entryId) : null;
  const modeName = `${baseId}-${spec.id}-mode`;
  return (
    <fieldset className="slot-row">
      <legend>{spec.label}{spec.required && <span aria-label="必填"> *</span>}</legend>
      <div className="slot-modes" role="radiogroup" aria-label={`${spec.label}选择方式`}>
        <label><input type="radio" name={modeName} checked={mode === 'random'} onChange={() => setSlotMode(spec.id, 'random')} />随机</label>
        <label><input type="radio" name={modeName} checked={mode === 'manual'} onChange={() => setSlotMode(spec.id, 'manual')} />手选</label>
      </div>

      {mode === 'random' ? (
        <div className="slot-random">
          <button type="button" onClick={() => rollSlot(spec.id, spec.poolId)}>随机抽一本</button>
          <span role="status">{picked ? `已固定：${picked.title}` : active.length === 0 ? '该池暂无可用书目' : '尚未抽取'}</span>
        </div>
      ) : (
        <select
          aria-label={`${spec.label}手选`} value={selection?.entryId ?? ''}
          onChange={e => pickSlot(spec.id, e.target.value as Id)}>
          <option value="" disabled>{active.length ? '请选择' : '该池暂无可用书目'}</option>
          {active.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      )}
    </fieldset>
  );
}

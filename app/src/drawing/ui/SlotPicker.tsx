import {useMemo, useState} from 'react';
import {Sphere} from '../../shared/ui/index.ts';
import type {WorkspaceDrawSession, WorkspaceDrawState} from '../workspace-session.ts';
import type {BookEntry, SlotSpec} from '../../workspace/index.ts';
import {shuffleCandidates} from '../selection.ts';
import {DROPDOWN_CAPACITY, dropdownOptions, sampleDropdownIds} from './dropdown-options.ts';

export function SlotPicker({spec, state, drawing, disabled}: {
  spec: SlotSpec; state: WorkspaceDrawState; drawing: WorkspaceDrawSession; disabled: boolean;
}) {
  const [sphere, setSphere] = useState<{books: readonly BookEntry[]; presented: string | null; revealed: string | null} | null>(null);
  const slot = state.preview?.slots.find(s => s.id === spec.id), selection = state.selections.find(s => s.slotId === spec.id);
  const candidateIds = JSON.stringify(slot?.candidates.map(book => book.id) ?? []);
  const bookLimit = DROPDOWN_CAPACITY - (spec.required ? 1 : 2);
  const sampledIds = useMemo(() => sampleDropdownIds(JSON.parse(candidateIds) as string[], bookLimit,
    () => crypto.getRandomValues(new Uint32Array(1))[0]), [candidateIds, bookLimit]);
  const options = dropdownOptions(slot?.candidates ?? [], sampledIds, selection?.entryId);
  return <fieldset disabled={disabled} className="production-draw-slot"><legend>{spec.label}{spec.required ? '（必填）' : '（可选）'}</legend>
    <label>{spec.label}选择<select aria-label={`${spec.label}选择`} value={selection ? `book:${selection.entryId}` : ''} onChange={e => {
      const value = e.target.value;
      if (value === 'random') void drawing.select(spec.id, {mode: 'random'});
      else if (value === 'empty') void drawing.setMode(spec.id, 'manual');
      else if (value.startsWith('book:')) void drawing.select(spec.id, {mode: 'manual', entryId: value.slice(5)});
    }}>
      <option value="" disabled hidden>{slot?.candidates.length ? '请选择' : '该池暂无可用书目'}</option>
      <option value="random" disabled={!slot?.candidates.length}>随机</option>
      {!spec.required && <option value="empty">留空</option>}
      {options.map(book => <option key={book.id} value={`book:${book.id}`}>{book.title}{book.author ? ` · ${book.author}` : ''}</option>)}
    </select></label>
    {slot && slot.candidates.length > bookLimit && <p className="muted">下拉框随机展示 {bookLimit} 本；“随机”和球面选择覆盖全池 {slot.candidates.length} 本。</p>}
    <div className="toolbar"><button type="button" disabled={!slot?.candidates.length} onClick={() => void drawing.select(spec.id, {mode: 'random'})}>再随机一次</button>
      <button type="button" disabled={!slot?.candidates.length} onClick={() => setSphere({books: shuffleCandidates(slot?.candidates ?? [], () => crypto.getRandomValues(new Uint32Array(1))[0]), presented: null, revealed: null})}>从球面选{spec.label}</button></div>
    <p role="status">{selection ? `已固定：${selection.entrySnapshot.title}` : slot?.candidates.length ? '尚未选择' : '该池暂无可用书目'}</p>
    {sphere && <div className="sphere-modal"><Sphere mode="draw" cards={sphere.books.map(book => ({id: book.id, face: 'back', frontData: {title: book.title, subtitle: book.author ?? undefined}}))}
      motionState={sphere.revealed ? 'revealed' : sphere.presented ? 'presented' : 'shuffling'} presentedId={sphere.presented} revealedId={sphere.revealed}
      onSelectCard={id => setSphere(s => s && !s.presented ? {...s, presented: id} : s)}
      onReveal={id => setSphere(s => s?.presented === id ? {...s, revealed: id} : s)} onClose={() => setSphere(null)}
      detail={sphere.revealed && <button type="button" className="primary" onClick={async () => {await drawing.select(spec.id, {mode: 'manual', entryId: sphere.revealed!}); setSphere(null);}}>使用这本书</button>}/></div>}
  </fieldset>;
}

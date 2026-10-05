import { useReducer, type KeyboardEvent } from 'react';
import {
  INITIAL_SESSION, drawReducer, keyIntent, primaryAction,
} from '../../../../../src/drawing/model.ts';
import type {
  BookEntry, ComboSelection, DailyCopy, Id, SlotId,
} from '../../../../../src/workspace/index.ts';

/** Injected data/randomness; the hook never reads the workspace or persists anything. */
export type DrawSessionSource = Readonly<{
  todayCopies: readonly DailyCopy[];
  entriesForSlot: (poolId: Id) => readonly BookEntry[];
  random: () => number;
  /** Fired only from a ready combo; B3 turns this into the formal AcceptDailyCopy command. */
  onAccept: (copy: DailyCopy, selections: readonly ComboSelection[], composedText: string) => void;
}>;

export function useDrawSession(source: DrawSessionSource) {
  const [session, dispatch] = useReducer(drawReducer, INITIAL_SESSION);
  const { phase } = session;

  const start = () => dispatch({ type: 'start', copies: source.todayCopies });
  const cancel = () => dispatch({ type: 'cancel' });

  const primary = () => {
    const action = primaryAction(phase);
    if (action === 'first-tap') dispatch({ type: 'first-tap', random: source.random() });
    else if (action === 'second-tap') dispatch({ type: 'second-tap' });
    else if (action === 'continue-to-combo') dispatch({ type: 'continue-to-combo' });
    else if (action === 'accept' && phase.kind === 'combo')
      source.onAccept(phase.copy, phase.selections, phase.composedText);
  };

  const setSlotMode = (slotId: SlotId, mode: 'random' | 'manual') =>
    dispatch({ type: 'set-slot-mode', slotId, mode });
  // Randomness is consumed in this event handler, not during render, and fixed in state.
  const rollSlot = (slotId: SlotId, poolId: Id) =>
    dispatch({ type: 'roll-slot', slotId, candidates: source.entriesForSlot(poolId), random: source.random() });
  const pickSlot = (slotId: SlotId, entryId: Id) =>
    dispatch({ type: 'pick-slot', slotId, entryId });
  const setComposed = (text: string) => dispatch({ type: 'set-composed', text });

  const onKeyDown = (event: KeyboardEvent) => {
    const intent = keyIntent(event.key);
    if (intent === null) return;
    event.preventDefault();
    if (intent === 'cancel') cancel();
    else primary();
  };

  return { session, actions: { start, cancel, primary, setSlotMode, rollSlot, pickSlot, setComposed }, onKeyDown };
}

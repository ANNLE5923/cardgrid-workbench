/**
 * B2 draw session: pure in-memory state machine (no persistence, no hand Instance).
 * The locked copy id is fixed at the first tap (stop) and must survive the reveal;
 * random slot picks are event-driven and fixed once, so re-renders never re-roll.
 */
import type {
  BookEntry, ComboSelection, DailyCopy, Id, SlotId,
} from '../workspace/index.ts';

export type DrawPhase =
  | Readonly<{ kind: 'shuffling' }>
  | Readonly<{ kind: 'presented'; copyId: Id }>
  | Readonly<{ kind: 'revealed'; copyId: Id }>
  | Readonly<{
    kind: 'combo'; copy: DailyCopy;
    selections: readonly ComboSelection[]; composedText: string; ready: boolean;
  }>;

export type DrawSession = Readonly<{
  deck: readonly DailyCopy[];
  phase: DrawPhase;
}>;

export const INITIAL_SESSION: DrawSession = { deck: [], phase: { kind: 'shuffling' } };

/** Events carry the data/randomness the reducer needs, keeping the reducer pure. */
export type DrawEvent =
  | Readonly<{ type: 'start'; copies: readonly DailyCopy[] }>
  | Readonly<{ type: 'present-copy'; copyId: Id }>
  | Readonly<{ type: 'validated-combo'; copyId: Id; selections: readonly ComboSelection[]; composedText: string; ready: boolean }>
  | Readonly<{ type: 'first-tap'; random: number }>
  | Readonly<{ type: 'second-tap' }>
  | Readonly<{ type: 'continue-to-combo' }>
  | Readonly<{ type: 'set-slot-mode'; slotId: SlotId; mode: 'random' | 'manual' }>
  | Readonly<{ type: 'roll-slot'; slotId: SlotId; candidates: readonly BookEntry[]; random: number }>
  | Readonly<{ type: 'pick-slot'; slotId: SlotId; entryId: Id }>
  | Readonly<{ type: 'set-composed'; text: string }>
  | Readonly<{ type: 'cancel' }>;

/** Uniform [0,1) doubles make floor(random*len) effectively unbiased at these lengths. */
function pickIndex(length: number, random: number): number {
  return Math.min(length - 1, Math.floor(random * length));
}

function isReady(copy: DailyCopy, selections: readonly ComboSelection[]): boolean {
  return copy.slotSpecSnapshot.every(spec =>
    !spec.required || selections.some(s => s.slotId === spec.id && s.entryId !== null));
}

function withSelections(phase: Extract<DrawPhase, { kind: 'combo' }>, selections: readonly ComboSelection[])
  : DrawPhase {
  return { ...phase, selections, ready: isReady(phase.copy, selections) };
}

export function drawReducer(state: DrawSession, event: DrawEvent): DrawSession {
  const { phase, deck } = state;
  switch (event.type) {
    case 'start':
      return { deck: event.copies, phase: { kind: 'shuffling' } };

    case 'present-copy':
      return deck.some(copy => copy.id === event.copyId) ? {...state, phase: {kind: 'presented', copyId: event.copyId}} : state;

    case 'validated-combo':
      return phase.kind === 'combo' && phase.copy.id === event.copyId
        ? {...state, phase: {...phase, selections: event.selections, composedText: event.composedText, ready: event.ready}} : state;

    case 'first-tap': {
      if (phase.kind !== 'shuffling' || deck.length === 0) return state; // stop only from the shuffle
      const copyId = deck[pickIndex(deck.length, event.random)].id;
      return { ...state, phase: { kind: 'presented', copyId } }; // id locked here
    }

    case 'second-tap': {
      if (phase.kind !== 'presented') return state; // no swapping after the stop
      return { ...state, phase: { kind: 'revealed', copyId: phase.copyId } }; // same id
    }

    case 'continue-to-combo': {
      if (phase.kind !== 'revealed') return state;
      const copy = deck.find(candidate => candidate.id === phase.copyId);
      if (!copy) return state;
      const selections: ComboSelection[] = copy.slotSpecSnapshot.map(spec =>
        ({ slotId: spec.id, mode: 'manual', entryId: null }));
      return { ...state, phase: { kind: 'combo', copy, selections, composedText: '', ready: isReady(copy, selections) } };
    }

    case 'set-slot-mode': {
      if (phase.kind !== 'combo') return state;
      // Switching mode clears the slot; a random slot must be explicitly re-rolled.
      const selections = phase.selections.map(s =>
        s.slotId === event.slotId ? { slotId: s.slotId, mode: event.mode, entryId: null } : s);
      return { ...state, phase: withSelections(phase, selections) };
    }

    case 'roll-slot': {
      if (phase.kind !== 'combo') return state;
      const current = phase.selections.find(s => s.slotId === event.slotId);
      if (!current || current.mode !== 'random') return state;
      const active = event.candidates.filter(entry => entry.status === 'active');
      const entryId = active.length === 0 ? null : active[pickIndex(active.length, event.random)].id;
      const selections = phase.selections.map(s => s.slotId === event.slotId ? { ...s, entryId } : s);
      return { ...state, phase: withSelections(phase, selections) };
    }

    case 'pick-slot': {
      if (phase.kind !== 'combo') return state;
      const selections = phase.selections.map((s): ComboSelection =>
        s.slotId === event.slotId ? { slotId: s.slotId, mode: 'manual', entryId: event.entryId } : s);
      return { ...state, phase: withSelections(phase, selections) };
    }

    case 'set-composed': {
      if (phase.kind !== 'combo') return state;
      return { ...state, phase: { ...phase, composedText: event.text } };
    }

    case 'cancel':
      return INITIAL_SESSION; // discard everything; nothing was written
  }
}

/* ---- Keyboard path (pure mappings; the hook fills in data and dispatches) ---- */

export type KeyIntent = 'primary' | 'cancel' | null;
export function keyIntent(key: string): KeyIntent {
  if (key === 'Enter' || key === ' ') return 'primary';
  if (key === 'Escape') return 'cancel';
  return null;
}

/** Context primary action for a phase. In combo, a ready acceptance is B3's command. */
export type PrimaryAction = 'first-tap' | 'second-tap' | 'continue-to-combo' | 'accept' | null;
export function primaryAction(phase: DrawPhase): PrimaryAction {
  switch (phase.kind) {
    case 'shuffling': return 'first-tap';
    case 'presented': return 'second-tap';
    case 'revealed': return 'continue-to-combo';
    case 'combo': return phase.ready ? 'accept' : null;
  }
}

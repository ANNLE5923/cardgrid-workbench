/** v0.6 B1/B2 pure rules. IDs, clock, authoritative reads and randomness are supplied by the caller. */
export {
  collectDecisionCandidates,
  selectDecisionAnswer,
  type DecisionCandidate,
  type DecisionCandidates,
  type AnswerChoice,
} from './candidates.ts';
export {
  createActionMaterial,
  createEntryMaterial,
  createAnswerMaterial,
  createDecisionMaterials,
  assertSameActionOwner,
  renderActionContent,
  inheritMaterialSources,
  type ActionMaterial,
  type AnswerMaterial,
  type EntryMaterial,
  type DailyOrigin,
} from './materials.ts';
export {
  previewSynthesis,
  prepareSynthesisConsumption,
  type CompositeMaterial,
  type SynthesisInput,
  type SynthesisDraft,
} from './synthesis.ts';
export {
  previewReferencePlacement,
  projectReferences,
  prepareReferenceReturn,
  prepareAttachedReferenceReturn,
  snapshotAttachedAnswers,
  type ReferencePlacementDraft,
  type ReferenceReturnDraft,
} from './references.ts';
export type { MaterialContext } from './material-state.ts';

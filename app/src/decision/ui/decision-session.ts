// A4 decision-session port. The matrix UI depends only on this interface and
// the workspace public DTOs; it never randomizes or writes the catalog itself.
// The in-memory implementation lives in the workshop (A line) and production
// wiring (app, B line) adapts the real B1/B5 session to this shape.
import type { AnswerSnapshot, HandCard, V06Result } from '../../workspace/v06.ts';
import type { Id, Token, VersionRef } from '../../workspace/index.ts';

export type DrawChoice =
  Readonly<{ kind: 'random' }> | Readonly<{ kind: 'manual'; entry: VersionRef }>;

export type DecisionCandidate = Readonly<{ entry: VersionRef; title: string }>;

export type DecisionCandidatesView = Readonly<{
  decision: VersionRef;
  candidates: readonly DecisionCandidate[];
  sourceDeckIds: readonly Id[];
}>;

export type DecisionDrawPreview = Readonly<{
  decision: VersionRef;
  candidates: readonly DecisionCandidate[];
  selected: AnswerSnapshot;
  sourceFingerprint: string;
}>;

export type AcceptDecisionAnswerResult = Readonly<{
  answer: HandCard;
  action: HandCard | null;
  token: Token;
}>;

export interface DecisionSessionPort {
  /** B5 optional lifecycle: reading a live draft never performs another draw. */
  readDecisionDraw?(
    input: Readonly<{ decision: VersionRef }>,
  ): Promise<V06Result<DecisionDrawPreview | null>>;
  /** B5 cancellation revokes only the unaccepted preview capability. */
  cancelDecisionDraw?(): Promise<V06Result<Readonly<{ cancelled: true }>>>;
  /** Read-only effective candidates (active union, de-duplicated); no draw. */
  listDecisionCandidates(
    input: Readonly<{ decision: VersionRef }>,
  ): Promise<V06Result<DecisionCandidatesView>>;
  /** Produce a fixed answer snapshot without adding a hand card. */
  previewDecisionDraw(
    input: Readonly<{ decision: VersionRef; choice: DrawChoice }>,
  ): Promise<V06Result<DecisionDrawPreview>>;
  /** Fix the answer and optionally also take the owner action (one accept). */
  acceptDecisionAnswer(
    input: Readonly<{
      decision: VersionRef;
      entry: VersionRef;
      alsoTakeAction: boolean;
    }>,
  ): Promise<V06Result<AcceptDecisionAnswerResult>>;
}

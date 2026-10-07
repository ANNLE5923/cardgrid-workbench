// Legacy v2 editors (read-mostly in v0.3).
export { ActionLibrary } from './ui/ActionLibrary.tsx';
export { ConfigurationPanel } from './ui/ConfigurationPanel.tsx';

// v0.3 workshop: production editor and host port.
export { WorkshopEditor } from './ui/WorkshopEditor.tsx';
export type { WorkshopHost, SaveOutcome } from './workshop-host.ts';
export {
  EMPTY_CONTEXT,
  bumpVersion,
  validateActionDraft,
  validateBookDraft,
  validatePoolDraft,
  validateRuleDraft,
  type WorkshopContext,
  type WorkshopIssue,
} from './model.ts';

export { WorkshopEditorV06 } from './ui/v06/WorkshopEditorV06.tsx';
export { createFormalCatalogEditor } from './formal-catalog-editor.ts';

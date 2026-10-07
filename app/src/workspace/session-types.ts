export type WorkspacePreview = {
  type: 'RestoreWorkspace' | 'CommitMigration' | 'ImportDefinitions';
  previewId: string;
  details: unknown;
  blocked: boolean;
  mode?: 'merge' | 'replace';
};

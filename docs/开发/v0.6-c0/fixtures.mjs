// C0 design inputs and literal expected outcomes. Not a production rule engine.
// Synthetic only; never load the personal workspace or import these from app/src.
export const CLOCK = '2026-10-06T00:12:00Z';
export const ZONE = 'Asia/Shanghai';
export const catalog = {
  actions: [
    {id: 'read', title: '阅读《{对象}》', fields: [{id: 'subject', label: '对象', type: 'text', required: true}]},
    {id: 'meal', title: '吃饭：{对象}', fields: [{id: 'subject', label: '对象', type: 'text', required: true}]},
    {id: 'train', title: '锻炼：{对象}', fields: [{id: 'subject', label: '对象', type: 'text', required: true}]},
  ],
  entries: [
    {id: 'book-a', title: '合成书目甲', attributes: {author: '合成作者'}},
    {id: 'food-a', title: '合成餐食甲', attributes: {}},
    {id: 'exercise-a', title: '合成锻炼甲', attributes: {minutes: 20}},
    {id: 'link-a', title: '合成网址', url: 'https://example.com/', attributes: {}},
  ],
  decks: [
    {id: 'books', kind: 'entry', memberIds: ['book-a']},
    {id: 'foods', kind: 'entry', memberIds: ['food-a']},
    {id: 'exercises', kind: 'entry', memberIds: ['exercise-a']},
    {id: 'loose-list', kind: 'entry', memberIds: ['link-a']},
    {id: 'empty-list', kind: 'entry', memberIds: []},
  ],
  decisions: [
    {id: 'which-book', ownerActionId: 'read', deckIds: ['books'], mappings: [{fieldId: 'subject', entryPath: 'title'}]},
    {id: 'which-food', ownerActionId: 'meal', deckIds: ['foods'], mappings: [{fieldId: 'subject', entryPath: 'title'}]},
    {id: 'which-exercise', ownerActionId: 'train', deckIds: ['exercises'], mappings: [{fieldId: 'subject', entryPath: 'title'}]},
    {id: 'which-book-again', ownerActionId: 'read', deckIds: ['books'], mappings: [{fieldId: 'subject', entryPath: 'title'}]},
  ],
};

export const cases = [
  ...[
    ['C01', 'read', 'which-book', 'book-a', '阅读《合成书目甲》'],
    ['C02', 'meal', 'which-food', 'food-a', '吃饭：合成餐食甲'],
    ['C03', 'train', 'which-exercise', 'exercise-a', '锻炼：合成锻炼甲'],
  ].map(([id, actionId, decisionId, entryId, title]) => ({
    id, operation: 'ConfirmSynthesis',
    input: {leftId: `${actionId}-take-1`, rightId: `${decisionId}-answer-1`, actionId, decisionId, entryId},
    expected: {consumedIds: [`${actionId}-take-1`, `${decisionId}-answer-1`], outputIds: [`${actionId}-result-1`], title, libraryChanged: false},
  })),
  {id: 'C04', operation: 'SaveDeck', input: {deckId: 'loose-list'}, expected: {bindingRequired: false, memberIds: ['link-a']}},
  {id: 'C05', operation: 'AcceptDecisionAnswer', input: {decisionId: 'which-book', alsoTakeAction: false}, expected: {answersAdded: 1, actionMaterialsAdded: 0}},
  {id: 'C06', operation: 'AcceptDecisionAnswer', input: {decisionId: 'which-book', alsoTakeAction: true}, expected: {answersAdded: 1, actionMaterialsAdded: 1, atomic: true}},
  {id: 'C07', operation: 'ConfirmSynthesis', input: {leftId: 'read-take-1', otherSameNameId: 'read-take-2', rightId: 'answer-1'}, expected: {consumedIds: ['read-take-1', 'answer-1'], untouchedIds: ['read-take-2']}},
  {id: 'C08', operation: 'ConfirmSynthesis', input: {commandId: 'same-command', retry: true}, expected: {replayed: true, additionalOutputs: 0}},
  {id: 'C09', operation: 'ConfirmSynthesis', input: {materialState: 'consumed'}, expected: {error: 'MATERIAL_CONSUMED', writes: 0}},
  {id: 'C10', operation: 'ConfirmSynthesis', input: {hasActivePlan: true}, expected: {error: 'MATERIAL_PLACED', writes: 0}},
  {id: 'C11', operation: 'ConfirmSynthesis', input: {hasFact: true}, expected: {error: 'FACT_LOCKED', writes: 0}},
  {id: 'C12', operation: 'ConfirmSynthesis', input: {currentValue: '甲', incomingValue: '乙', resolution: null}, expected: {error: 'FIELD_CONFLICT', writes: 0}},
  {id: 'C13', operation: 'ConfirmSynthesis', input: {currentValue: '甲', incomingValue: '乙', resolution: 'keep'}, expected: {value: '甲', bothProvenancesRetained: true}},
  {id: 'C14', operation: 'ConfirmSynthesis', input: {currentValue: '甲', incomingValue: '乙', resolution: 'replace'}, expected: {value: '乙', bothProvenancesRetained: true}},
  {id: 'C15', operation: 'ConfirmSynthesis', input: {expiryInstants: ['2026-10-08T16:00:00Z', null]}, expected: {expiresAt: '2026-10-08T16:00:00Z'}},
  {id: 'C16', operation: 'PlaceReference', input: {mode: 'point', at: '2026-10-06T00:00:00Z'}, expected: {occupiedMinutes: 0, factsAdded: 0}},
  {id: 'C17', operation: 'RetractPlan', input: {instanceId: 'breakfast', reflectionId: 'note-1'}, expected: {automaticRows: 0, reflectionIds: ['note-1'], answerReturnedToHand: true}},
  {id: 'C18', operation: 'MovePlan', input: {from: '08:00', to: '10:00', instanceId: 'breakfast'}, expected: {sourceKey: 'instance:breakfast', rowStart: '10:00', rows: 1}},
  {id: 'C19', operation: 'UpdateJournalNote', input: {recordedAt: '2026-10-06T00:12:00Z', updateAt: '2026-10-06T02:15:00Z'}, expected: {recordedAt: '2026-10-06T00:12:00Z', updatedAt: '2026-10-06T02:15:00Z'}},
  {id: 'C20', operation: 'RenderJournal', input: {range: ['2026-10-05T15:00:00Z', '2026-10-05T22:00:00Z'], zone: ZONE}, expected: {dates: ['2026-10-05', '2026-10-06'], sharedSourceKey: true}},
  {id: 'C21', operation: 'SaveJournalNote', input: {date: '2026-10-07', workspaceToday: '2026-10-06'}, expected: {error: 'FUTURE_DATE', writes: 0}},
  {id: 'C22', operation: 'MigrateV4Journal', input: {text: '原文\r\n\n 空格保留 ', createdAt: '2026-10-01T00:00:00Z'}, expected: {kind: 'legacy-block', exactText: '原文\r\n\n 空格保留 ', inferredTimes: 0}},
  {id: 'C23', operation: 'WriteText', input: {workspaceCommitted: true, permission: 'denied'}, expected: {businessSuccess: true, fileState: 'permission-required', retryCommand: false}},
  {id: 'C24', operation: 'WriteText', input: {fileBytes: '外部改动', lastSuccessfulBytes: '旧输出', pendingBytes: '新输出'}, expected: {order: ['preserve-external', 'restore-last-success', 'write-latest'], workspaceRollback: false}},
  {id: 'C25', operation: 'WriteText', input: {fileBytes: '旧输出', lastSuccessfulBytes: '旧输出', pendingBytes: '新输出'}, expected: {externalChange: false, nextBytes: '新输出'}},
  {id: 'C26', operation: 'WriteText', input: {taskEpoch: 'old', currentEpoch: 'new'}, expected: {error: 'WORKSPACE_REPLACED', writes: 0}},
  {id: 'C27', operation: 'WriteText', input: {closeSucceeded: true, metadataCommitSucceeded: false}, expected: {fileState: 'reconcile-required', doNotReportSynced: true}},
  {id: 'C28', operation: 'RestoreBackup', input: {version: 4}, expected: {restoredVersion: 4, autoMigrate: false, textQueuePaused: true}},
  {id: 'C29', operation: 'OpenListUrl', input: {url: 'https://example.com/'}, expected: {record: 'open-requested', claimsExternalPageRead: false}},
  {id: 'C30', operation: 'SaveDeck', input: {members: 101}, expected: {error: 'POOL_CAPACITY_EXCEEDED', writes: 0}},
  {id: 'C31', operation: 'ConfirmSynthesis', input: {ownerActionId: 'read', actionId: 'meal'}, expected: {error: 'ACTION_OWNER_MISMATCH', writes: 0}},
  {id: 'C32', operation: 'WriteText', input: {preserveExternalFailed: true}, expected: {fileState: 'conflict-copy-failed', overwriteExternal: false}},
];

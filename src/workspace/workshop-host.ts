import type {WorkspaceClient} from './client.ts';
import type {Command, Token} from './contracts.ts';
import type {WorkshopHost, SaveOutcome} from '../workshop/index.ts';
import {validateWorkshopEntity} from '../workshop/model.ts';
import type {WorkshopContext, WorkshopCatalog, WorkshopEntity} from '../workshop/model.ts';
import {sameValue} from '../daily/model.ts';

/** Stateful UI adapter: captured token/base versions and stable retry ids, never an extra store. */
export function createWorkshopHost(client: WorkspaceClient): WorkshopHost {
  let loaded: {token: Token; catalog: WorkshopCatalog} | null = null;
  let pending: {draft: WorkshopEntity; command: Command} | null = null;
  const context = (catalog: WorkshopCatalog): WorkshopContext => ({actionCards: catalog.actionCards, bookEntries: catalog.bookEntries, pools: catalog.pools, rules: catalog.generationRules});
  const load = async (): Promise<SaveOutcome<WorkshopContext>> => {
    const snapshot = await client.load();
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.data?.version !== 3) return {ok: false, code: 'UNSUPPORTED_VERSION', message: '请先备份、预览并显式升级到 Data v3'};
    const read = await client.readWorkshop({token: snapshot.value.token});
    if (!read.ok) return read;
    loaded = {token: read.value.token, catalog: read.value.catalog}; pending = null;
    return {ok: true, value: context(read.value.catalog)};
  };
  const save = async <K extends keyof WorkshopCatalog>(collection: K, draft: WorkshopCatalog[K][number]): Promise<SaveOutcome<WorkshopCatalog[K][number]>> => {
    if (!loaded) return {ok: false, code: 'PREVIEW_STALE', message: '请先载入工坊后再保存'};
    const checked = validateWorkshopEntity(collection, draft);
    if (!checked.ok) return {ok: false, code: 'INVALID_INPUT', message: checked.issues.map(i => i.message).join('; '), issues: checked.issues};
    let command: Command;
    if (pending && sameValue(pending.draft, draft)) command = pending.command;
    else {
      const previous = loaded.catalog[collection].find(item => item.id === draft.id);
      if (previous && draft.version !== previous.version || !previous && draft.version !== 1)
        return {ok: false, code: 'REVISION_CONFLICT', message: '草稿版本已变化，请重新载入'};
      const candidate = {...draft, version: previous?.version ?? 1};
      const entity = previous && !sameValue(previous, candidate) ? {...candidate, version: previous.version + 1} : candidate;
      const type = collection === 'actionCards' ? 'SaveActionCard' : collection === 'bookEntries' ? 'SaveBookEntry' : collection === 'pools' ? 'SavePool' : 'SaveGenerationRule';
      const key = collection === 'actionCards' ? 'actionCard' : collection === 'bookEntries' ? 'bookEntry' : collection === 'pools' ? 'pool' : 'generationRule';
      command = {commandId: crypto.randomUUID(), expected: loaded.token, type, payload: {[key]: entity, expectedVersion: previous?.version ?? null}} as Command;
      pending = {draft: structuredClone(draft), command};
    }
    const result = await client.submit(command);
    if (!result.ok) {if (result.retry !== 'same-command') pending = null; return result;}
    const snapshot = await client.load();
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.data?.version !== 3) return {ok: false, code: 'WORKSPACE_REPLACED', message: '工作区已被替换，请重新载入'};
    const data = snapshot.value.data;
    loaded = {token: snapshot.value.token, catalog: {actionCards: data.actionCards, bookEntries: data.bookEntries, pools: data.pools, generationRules: data.generationRules}};
    pending = null;
    const saved = data[collection].find(item => item.id === draft.id);
    if (!saved) return {ok: false, code: 'WORKSPACE_REPLACED', message: '已保存对象不在当前工作区，请重新载入'};
    return {ok: true, value: structuredClone(saved) as WorkshopCatalog[K][number]};
  };
  return {load, saveActionCard: draft => save('actionCards', draft), saveBookEntry: draft => save('bookEntries', draft),
    savePool: draft => save('pools', draft), saveGenerationRule: draft => save('generationRules', draft)};
}

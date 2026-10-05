import assert from 'node:assert/strict';
import {createWorkspaceClient} from '../../../src/workspace/client.ts';
import type {Command, Result} from '../../../src/workspace/contracts.ts';
import type {AtomicChange, WorkspaceStore} from '../../../src/workspace/store.ts';
import {actionCard, bookEntry, pool, rule} from '../workshop/a1-fixtures.ts';
import type {DailyCopy} from '../../../src/workspace/contracts-v3.ts';
export {actionCard, bookEntry, pool, rule};

export function ok<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
export function harness() {
  let raw: unknown, recovery: readonly {key: IDBValidKey; value: unknown}[] = [];
  let at = '2026-10-04T04:00:00Z', sequence = 0, writes = 0, fail = false, lose = false;
  const listeners = new Set<(external: boolean) => void>();
  const randomValues: number[] = [];
  const store: WorkspaceStore = {
    read: async () => structuredClone(raw), readRecovery: async () => structuredClone(recovery),
    async atomic<T>(reduce: (raw: unknown) => AtomicChange<T>): Promise<T> {
      const change = reduce(structuredClone(raw));
      if (fail) {fail = false; throw new Error('synthetic transaction abort');}
      if (Object.hasOwn(change, 'write')) {
        recovery = change.clearRecovery ? [] : raw === undefined ? recovery : [{key: 'previous', value: {raw: structuredClone(raw), reason: change.reason, createdAt: change.at}}];
        raw = structuredClone(change.write); writes++; listeners.forEach(listener => listener(false));
        if (lose) {lose = false; throw new Error('synthetic lost reply after commit');}
      }
      return change.result;
    },
    subscribe(fn) {listeners.add(fn); return () => {listeners.delete(fn);};}, close() {listeners.clear();},
  };
  const client = createWorkspaceClient({store, now: () => at, id: () => `v3-${++sequence}`, random: () => randomValues.shift() ?? 0});
  const token = async () => ok(await client.load()).token;
  async function command(type: Command['type'], payload: unknown, commandId = `request-${++sequence}`): Promise<Command> {
    return {type, payload, expected: await token(), commandId} as Command;
  }
  const submit = async (type: Command['type'], payload: unknown) => client.submit(await command(type, payload));
  async function data() {const value = ok(await client.load()).data; assert.equal(value?.version, 3); if (value?.version !== 3) throw new Error('not v3'); return value;}
  async function setup() {
    ok(await submit('SaveBookEntry', {bookEntry: bookEntry(), expectedVersion: null}));
    ok(await submit('SavePool', {pool: pool(), expectedVersion: null}));
    ok(await submit('SaveActionCard', {actionCard: actionCard(), expectedVersion: null}));
    ok(await submit('SaveGenerationRule', {generationRule: rule(), expectedVersion: null}));
  }
  async function generate() {ok(await submit('GenerateDailyCopies', {target: 'current'})); return (await data()).dailyCopies.at(-1)!;}
  async function selection(input?: DailyCopy) {
    const copy = input ?? (await data()).dailyCopies[0];
    return ok(await client.selectEntry({token: await token(), copy: {id: copy.id, version: copy.version}, slotId: 'book', choice: {mode: 'manual', entryId: 'book-1'}})).selection!;
  }
  async function accept(input?: DailyCopy) {
    const copy = input ?? (await data()).dailyCopies[0];
    const selected = await selection(copy), ref = {id: copy.id, version: copy.version};
    const preview = ok(await client.previewCombo({token: await token(), copy: ref, selections: [selected]}));
    const result = ok(await submit('AcceptDailyCopy', {copy: ref, selections: [selected], composedText: preview.composedText}));
    return (await data()).planner.instances.find(i => i.id === ('id' in result.resultRefs[0] ? result.resultRefs[0].id : ''))!;
  }
  return {client, store, token, command, submit, data, setup, generate, selection, accept, randomValues,
    setNow(value: string) {at = value;}, failNext() {fail = true;}, loseNextReply() {lose = true;},
    evidence: () => structuredClone({raw, recovery, writes}), writes: () => writes};
}

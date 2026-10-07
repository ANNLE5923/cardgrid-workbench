import type { Instance, WorkspaceData } from '../../workspace/index.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** A display group, never a merged entity. Copy/date/selection timestamps stay on each member. */
export function handStackKey(instance: Instance, data: WorkspaceData): string {
  if (!instance.daily || (data.version !== 3 && data.version !== 4))
    return `instance:${instance.id}`;
  const copy = data.dailyCopies.find((copy) => copy.id === instance.daily!.copyId);
  if (!copy) return `instance:${instance.id}`;
  return stable({
    card: copy.actionCard,
    content: instance.currentContent,
    ruleId: copy.ruleId,
    ruleVersion: copy.ruleVersion,
    slots: instance.daily.slotSelections
      .map((s) => ({ slotId: s.slotId, entry: s.entrySnapshot }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
  });
}

export function groupHand(
  hand: readonly Instance[],
  data: WorkspaceData,
): readonly { key: string; members: readonly Instance[] }[] {
  const groups = new Map<string, Instance[]>();
  for (const instance of hand) {
    const key = handStackKey(instance, data),
      members = groups.get(key) ?? [];
    members.push(instance);
    groups.set(key, members);
  }
  return [...groups].map(([key, members]) => ({ key, members }));
}

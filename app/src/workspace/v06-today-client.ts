/** Read-only compatibility projection for the existing dial UI. Writes stay v5. */
import type { ErrorCode, Result, EntityRef } from './contracts.ts';
import type { V06Result } from './contracts-v06.ts';
import type { WorkspaceClient } from './client.ts';
import type { V06Host } from './v06-host.ts';
import { plannerView } from './v5-today.ts';
import { resolveLocal } from '../daily/time.ts';
import { commandFailure } from './commands.ts';
export type TodayClient = Pick<
  WorkspaceClient,
  | 'load'
  | 'readDay'
  | 'previewPlacement'
  | 'previewActual'
  | 'unlockFixed'
  | 'cancelPreview'
  | 'resolveLocal'
  | 'submit'
  | 'subscribe'
  | 'invalidateCapabilities'
>;
function legacyFailure(
  r: Exclude<V06Result<never>, { ok: true }>,
): Exclude<Result<never>, { ok: true }> {
  const preserve = [
    'WORKSPACE_REPLACED',
    'REVISION_CONFLICT',
    'PREVIEW_STALE',
    'OVERLAP_CONFIRMATION_REQUIRED',
    'FIXED_LOCKED',
    'STORAGE_FAILED',
    'FACT_LOCKED',
    'COPY_EXPIRED',
    'ALREADY_PLANNED',
    'ALREADY_CONFIRMED',
    'INVALID_GRID',
    'MIGRATION_BLOCKED',
  ];
  return { ...r, code: preserve.includes(r.code) ? (r.code as ErrorCode) : 'INVALID_INPUT' };
}
export function createV06TodayClient(host: V06Host): TodayClient {
  return {
    async load() {
      const r = await host.loadV5();
      if (!r.ok) return legacyFailure(r);
      return {
        ok: true,
        value: {
          mode: 'current',
          token: r.value.token,
          data: plannerView(r.value.data),
          raw: null,
          rawKey: 'v5-ui-projection-only',
        },
      };
    },
    async readDay(input) {
      const r = await host.readDay(input);
      return r.ok ? r : legacyFailure(r);
    },
    previewPlacement: host.previewPlacement,
    previewActual: host.previewActual,
    unlockFixed: host.unlockFixed,
    cancelPreview(previewId) {
      void host.loadV5().then((r) => {
        if (r.ok) void host.cancelPreview({ token: r.value.token, previewId });
      });
    },
    resolveLocal(input) {
      try {
        return { ok: true, value: resolveLocal(input) };
      } catch (e) {
        return commandFailure(e);
      }
    },
    async submit(command) {
      const r = await host.submit(command);
      if (!r.ok) return { ...r, code: 'INVALID_INPUT' };
      return {
        ok: true,
        value: {
          ...r.value,
          resultRefs: r.value.resultRefs.filter((r) =>
            [
              'instance',
              'fact',
              'plan',
              'fixed',
              'annotation',
              'day',
              'capture',
              'definition',
              'rule',
              'template',
              'project',
              'goal',
              'settings',
            ].includes(r.kind),
          ) as EntityRef[],
        },
      };
    },
    subscribe: host.subscribe,
    invalidateCapabilities: host.invalidateCapabilities,
  };
}

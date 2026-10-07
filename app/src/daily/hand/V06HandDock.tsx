import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { V06Host } from '../../workspace/index.ts';
import { createV06HandSession } from './v06-hand-session.ts';
import { GlobalHandDock } from './GlobalHandDock.tsx';
import type { HandPlayRequest } from './unified.ts';

/** B7 supplies its Today placement handler; other pages never receive a write callback. */
export function V06HandDock({
  host,
  isToday = false,
  onPlay,
}: Readonly<{ host: V06Host; isToday?: boolean; onPlay?: (request: HandPlayRequest) => void }>) {
  const session = useMemo(() => createV06HandSession(host), [host]),
    state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    lock = useRef(false),
    route = useRef(isToday);
  route.current = isToday;
  useEffect(() => {
    void session.start();
    const wake = () => {
      if (document.visibilityState === 'visible') void session.refresh();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      session.close();
    };
  }, [session]);
  useEffect(() => {
    setError('');
  }, [state.view?.token.epoch, isToday]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      const now = Date.now(),
        end = Math.min(
          ...(state.view?.items ?? []).flatMap((i) =>
            i.expiresAt && Date.parse(i.expiresAt) > now ? [Date.parse(i.expiresAt)] : [],
          ),
        );
      if (Number.isFinite(end))
        timer = setTimeout(
          () => void session.refresh(),
          Math.min(2147483647, Math.max(1, end - now + 1)),
        );
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [state.view, session]);
  return (
    <GlobalHandDock
      view={state.view}
      loading={state.loading}
      error={state.error || error}
      onRefresh={() => {
        setError('');
        void session.refresh();
      }}
      isToday={isToday}
      busy={busy}
      onPlay={
        onPlay
          ? async (item, view) => {
              if (lock.current || !route.current) return;
              lock.current = true;
              setBusy(true);
              setError('');
              try {
                const r = await session.preparePlay({
                  isToday: route.current,
                  token: view.token,
                  key: item.key,
                  version: item.version,
                });
                if (!route.current) return;
                if (!r.ok) {
                  setError(r.message);
                  return;
                }
                onPlay({ requestId: crypto.randomUUID(), ...r.value });
              } finally {
                lock.current = false;
                setBusy(false);
              }
            }
          : undefined
      }
    />
  );
}

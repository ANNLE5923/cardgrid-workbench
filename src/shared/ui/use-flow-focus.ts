import { useEffect, useRef } from 'react';

/** Keep keyboard interaction in a modal and restore the launch context on exit. */
export function useFlowFocus(onEscape: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const section = trigger?.closest('section');
    root.focus();
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); escapeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) {
        event.preventDefault(); first.focus();
      }
    };
    const contain = (event: FocusEvent) => { if (!root.contains(event.target as Node)) root.focus(); };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', contain);
      queueMicrotask(() => {
        if (document.querySelector('.flow-overlay')) return;
        const target = trigger?.isConnected ? trigger : section?.isConnected ? section.querySelector<HTMLElement>('h2') : null;
        if (target) { if (!target.matches('button, input, select, textarea, a[href]')) target.tabIndex = -1; target.focus(); }
      });
    };
  }, []);
  return rootRef;
}

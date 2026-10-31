// Gives focus back after a busy form re-enables its fields.
import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Returns focus to the control inside `ref` that had it when `busy` turned
 * true, once `busy` turns false again. Disabling a fieldset blurs its
 * focused control to the page body, and nothing else gives focus back.
 *
 * The hook records the control in a layout effect, which runs before the
 * browser blurs the disabled control.
 */
export function useRestoreFocusAfterBusy(ref: RefObject<HTMLElement | null>, busy: boolean): void {
  const focusedBeforeBusy = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (busy) {
      const active = document.activeElement as HTMLElement | null;
      focusedBeforeBusy.current = active && el.contains(active) ? active : null;
      return;
    }
    const back = focusedBeforeBusy.current;
    focusedBeforeBusy.current = null;
    const now = document.activeElement;
    // Leave focus alone when something else in the form, or outside it, took it meanwhile.
    const lost = now === null || now === document.body || now === el;
    if (back && back.isConnected && lost) back.focus();
  }, [ref, busy]);
}

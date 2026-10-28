// Installs a window-level handler for application chords.
import { useEffect, useRef } from "react";
import { findBinding, isApplicationChord, type ChordBinding } from "./chords";

/**
 * Runs the matching binding for every application chord pressed anywhere in
 * the window, in the capture phase, so a focused terminal never sees it.
 * Application chords with no binding are left alone.
 */
export function useChords(bindings: readonly ChordBinding[]): void {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isApplicationChord(e)) return;
      const binding = findBinding(e, ref.current);
      if (!binding) return;
      e.preventDefault();
      e.stopPropagation();
      if (binding.enabled !== false) binding.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

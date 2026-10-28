// Keyboard chords. Every application shortcut is a `Ctrl+Shift` chord, plus
// `F5` and `Alt+1` to `Alt+9`, so that every other key reaches the program
// running in a terminal pane. This is the Qt app's convention
// (`TerminalWidget::isApplicationChord`), kept on purpose.

/** A parsed chord such as `Ctrl+Shift+N`. */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** The key, normalized: an uppercase letter or digit, or a name such as `F5` or `ArrowRight`. */
  key: string;
}

/** The subset of `KeyboardEvent` that chord matching reads. */
export type KeyLike = Pick<
  KeyboardEvent,
  "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "key" | "code"
>;

const keyAliases: Record<string, string> = {
  right: "ArrowRight",
  left: "ArrowLeft",
  up: "ArrowUp",
  down: "ArrowDown",
  pgup: "PageUp",
  pgdown: "PageDown",
  esc: "Escape",
  del: "Delete",
};

/** Parses `Ctrl+Shift+N`, `Alt+3`, `F5`, or `Ctrl+Shift+Right`. */
export function parseChord(text: string): Chord {
  const parts = text.split("+").map((p) => p.trim());
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") chord.ctrl = true;
    else if (lower === "shift") chord.shift = true;
    else if (lower === "alt") chord.alt = true;
    else if (lower === "meta" || lower === "cmd") chord.meta = true;
    else chord.key = keyAliases[lower] ?? (part.length === 1 ? part.toUpperCase() : part);
  }
  if (chord.key === "") throw new Error(`The chord "${text}" names no key.`);
  return chord;
}

/**
 * The key of an event, normalized like `parseChord`. Letters and digits come
 * from `code`, so `Ctrl+Shift+2` (which types `@`) and a non-Latin layout
 * still match.
 */
export function eventKey(e: KeyLike): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export function matchChord(e: KeyLike, chord: Chord): boolean {
  return (
    e.ctrlKey === chord.ctrl &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt &&
    e.metaKey === chord.meta &&
    eventKey(e) === chord.key
  );
}

/** Formats a chord for a menu: `Ctrl+Shift+N`. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  if (chord.meta) parts.push("Meta");
  const names: Record<string, string> = {
    ArrowRight: "Right",
    ArrowLeft: "Left",
    ArrowUp: "Up",
    ArrowDown: "Down",
  };
  parts.push(names[chord.key] ?? chord.key);
  return parts.join("+");
}

const modifierKeys = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * True when the key belongs to the application, not to a terminal pane:
 * every `Ctrl+Shift` chord, `Alt+1` to `Alt+9`, and `F5`.
 */
export function isApplicationChord(e: KeyLike): boolean {
  if (modifierKeys.has(e.key)) return false;
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) return true;
  if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(eventKey(e))) {
    return true;
  }
  return e.key === "F5" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
}

/** A chord binding: the chord text and what it does. */
export interface ChordBinding {
  chord: string;
  run: () => void;
  /** When false the chord is swallowed but does nothing, as for a disabled action. */
  enabled?: boolean;
}

/** Finds the binding for a key event, or `undefined` when none matches. */
export function findBinding(
  e: KeyLike,
  bindings: readonly ChordBinding[],
): ChordBinding | undefined {
  return bindings.find((b) => matchChord(e, parseChord(b.chord)));
}

/**
 * Returns the chords that more than one binding uses. 3.3.5 shipped with
 * `Ctrl+Shift+A` bound twice, which silently disabled both actions; a test
 * calls this on the app's bindings.
 */
export function duplicateChords(bindings: readonly ChordBinding[]): string[] {
  const seen = new Map<string, number>();
  for (const b of bindings) {
    const k = formatChord(parseChord(b.chord));
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

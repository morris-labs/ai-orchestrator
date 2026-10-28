// The application chords, as inventory section 1.1 lists them, with the
// 3.3.5 duplicate resolved: Ctrl+Shift+A is Stop All Running, and Attach to
// Claude Session moves to Ctrl+Shift+J. Ctrl+Shift+C and Ctrl+Shift+V stay
// free for copy and paste inside a terminal.
export const CHORDS = {
  newBox: "Ctrl+Shift+N",
  sshRemotes: "Ctrl+Shift+R",
  edit: "Ctrl+Shift+E",
  fork: "Ctrl+Shift+K",
  start: "Ctrl+Shift+O",
  stopAll: "Ctrl+Shift+A",
  startAllStopped: "Ctrl+Shift+U",
  openShell: "Ctrl+Shift+T",
  attach: "Ctrl+Shift+J",
  refresh: "F5",
  details: "Ctrl+Shift+D",
  closeTab: "Ctrl+Shift+W",
  filter: "Ctrl+Shift+F",
  nextTab: "Ctrl+Shift+Right",
  prevTab: "Ctrl+Shift+Left",
  quit: "Ctrl+Shift+Q",
} as const;

export type ChordName = keyof typeof CHORDS;

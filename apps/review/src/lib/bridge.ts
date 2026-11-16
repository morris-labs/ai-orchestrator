// The optional Electron bridge. The preload script puts it on
// `window.aio`; in a plain browser it is absent, and the page's own
// origin and session cookie authenticate.

/** What the Electron preload exposes. */
export interface AioBridge {
  appVersion?: string;
  relaunch?: () => void;
  /** The server token on the first call, `null` on every later one. */
  takeToken(): string | null;
  serverUrl: string | null;
  onNavigate?(listener: (hash: string) => void): () => void;
}

/** The bridge, or `undefined` in a plain browser. */
export function bridge(): AioBridge | undefined {
  return (globalThis as { aio?: AioBridge }).aio;
}

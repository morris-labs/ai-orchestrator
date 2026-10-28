// The optional Electron bridge. The preload script puts it on
// `window.agentbox`; in a plain browser it is absent, and the page's own
// origin and session cookie authenticate.

/** What the Electron preload exposes. */
export interface AgentboxBridge {
  token: string | null;
  serverUrl: string | null;
  onNavigate?(listener: (hash: string) => void): () => void;
  setActiveRuns?(count: number): void;
}

/** The bridge, or `undefined` in a plain browser. */
export function bridge(): AgentboxBridge | undefined {
  return (globalThis as { agentbox?: AgentboxBridge }).agentbox;
}

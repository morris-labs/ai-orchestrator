// The React providers and hooks for the API client and the event stream,
// without the components or the terminal. An app that only needs these, such
// as the review app, imports `@agentbox/ui/hooks` and keeps xterm.js out of
// its bundle.
export * from "./api/react";
export * from "./events/react";

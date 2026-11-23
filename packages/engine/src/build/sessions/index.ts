// The session registry of a build: each agent's session with its seat and
// task, the message queue that gives a session one turn at a time, and the
// rule that picks between a resume and a fresh agent.
export { freshReason, samePlacement } from "./rule.js";

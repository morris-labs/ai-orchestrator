// The session registry of a build: each agent's session with its seat and
// tasks, the message queue that gives a seat one turn at a time, and the
// rule that picks between a resume and a fresh agent. See the design's
// "Session resume" section.
export { SessionDesk, briefOf, type SeatSession } from "./desk.js";
export {
  COMMIT_SUMMARY_LIMIT,
  TURN_ANSWER,
  commitSummary,
  describeMessage,
  freshPrompt,
  resumePrompt,
} from "./prompts.js";
export { SessionRegistryFile, type SessionStart } from "./registry.js";
export { freshReason, samePlacement } from "./rule.js";

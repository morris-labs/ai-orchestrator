// The Project manager's usage. The Project manager is the main session of
// the box that runs a build, and it makes no engine calls, so no lease
// settlement records what it spends. Instead the engine reads the token
// counts from the session's Claude Code transcript at each digest and sends
// them in a `build.seat.usage` event. The usage by seat marks the seat as
// tokens only: a session on the box's own account has no cost estimate.
//
// The `aio-build` command runs in the Project manager's session, so it
// names that session in two headers on each request. The engine records the
// sessions of the build's own box in the build's `pm-sessions.json` file and
// reads their transcripts, so a session that a resume or a fork replaced
// still counts.
import { z } from "zod";
import { BuildIdSchema, SeatSchema } from "./build-events.js";
import { CountSchema, IsoDateTimeSchema } from "./common.js";
import { TEAM_SEATS } from "./messages.js";

/** The seat name of the Project manager in digests and in the usage by seat. */
export const PM_SEAT = TEAM_SEATS.projectManager;

/** Where a build records its Project manager's sessions, relative to the build directory. */
export const PM_SESSIONS_FILE = "pm-sessions.json";

/**
 * The headers that name the session behind an `aio-build` request: Claude
 * Code's session ID, from `CLAUDE_CODE_SESSION_ID`, and the folder that
 * holds the account's transcripts, `CLAUDE_CONFIG_DIR/projects`.
 */
export const BUILD_SOCKET_SESSION_HEADERS = {
  id: "x-aio-claude-session",
  transcripts: "x-aio-claude-transcripts",
} as const;

/** One Claude Code session of the Project manager. */
export const PmSessionSchema = z.object({
  /** Claude Code's session ID, which names its transcript file. */
  id: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z-]{0,127}$/, {
    message: "use the session id: letters, digits, and hyphens",
  }),
  /** The folder with one subfolder of transcripts for each working directory. */
  transcripts: z.string().startsWith("/", { message: "use an absolute transcripts path" }),
  /** When a request first named the session. */
  seenAt: IsoDateTimeSchema,
});
export type PmSession = z.infer<typeof PmSessionSchema>;

/**
 * The payload of `build.seat.usage`: what a tokens only seat's session spent
 * from `since` through `through`. Each event replaces the one before for
 * the same build and seat.
 */
export const buildSeatUsageFields = {
  buildId: BuildIdSchema,
  seat: SeatSchema,
  /** The session's model responses, each counted once. */
  turns: CountSchema,
  /** Input tokens, cache reads and writes included. */
  tokensIn: CountSchema,
  tokensOut: CountSchema,
  /** When the build's planning started: earlier turns don't count. */
  since: IsoDateTimeSchema,
  /** When the engine read the transcript. */
  through: IsoDateTimeSchema,
};

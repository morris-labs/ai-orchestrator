// The `aio-box-review` command: starts a review run of this box's own
// branch through the secrets broker, waits for it to end, and prints the
// confirmed findings. The server takes the project from the container's
// broker socket or token and the box from `AIO_BOX_ID`, which it sets in
// every box session, and refuses another project's box or another branch.
import {
  BUILD_SOCKET_ENV,
  ProfileSchema,
  RunDepthSchema,
  type BrokerReviewRunResponse,
  type BrokerReviewStartRequest,
  type Finding,
  type RunState,
} from "@aio/contracts";
import { BrokerClient, BrokerError, type BrokerClientErrorCode } from "../secrets/broker-client.js";

export const BOX_REVIEW_USAGE = `Usage:
  aio-box-review start [--base REF] [--branch BRANCH] [--read-only]
                       [--profile PROFILE] [--depth DEPTH] [--no-wait] [--json]
  aio-box-review status RUN_ID [--wait] [--json]
  aio-box-review help

Starts a review run of this box's own branch through the AI Orchestrator
secrets broker, and reports its result.

Requests:
  start     Start a review run of the box's branch, wait until it ends, and
            print its confirmed and fixed findings. The run fixes what it
            confirms in the box's working tree unless you give --read-only,
            so hold your edits until it ends.
  status    Print the run RUN_ID that this box started. With --wait, wait
            until it ends first.

Options:
  --base REF        The base ref, such as origin/main (the default).
  --branch BRANCH   The branch to review. It must be the box's own branch,
                    which is also the default.
  --read-only       Review without fixing.
  --profile PROFILE offload (the default), balanced, or fast.
  --depth DEPTH     standard (the default) or thorough.
  --no-wait         Print the run's ID and return without waiting.
  --json            Print the run and its findings as JSON.

Exit status: 0 when the run finished, 1 when it failed or was cancelled or
for any other failure, 2 for a usage error, 3 when the broker can't be
reached, 4 when the server refuses the request, such as for another branch,
and 6 when the run waits for a decision in the Review app.
`;

/** How often the command reads the run while it waits. */
export const POLL_MS = 15_000;

/** The run statuses after which a run changes no more without a person. */
const ENDED: ReadonlySet<RunState["status"]> = new Set(["finished", "failed", "cancelled"]);

/** The verdicts the command prints: what the run confirmed, fixed or not. */
const REPORTED: ReadonlySet<Finding["verdict"]> = new Set(["confirmed", "fixed"]);

const REFUSED: ReadonlySet<BrokerClientErrorCode> = new Set([
  "validation",
  "not_found",
  "run_not_found",
]);

export interface BoxReviewCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** The broker to ask. Default: a `BrokerClient` for `env`. */
  client?: Pick<BrokerClient, "startReview" | "reviewRun">;
  /** Waits between reads of the run. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type BoxReviewCommand =
  | { kind: "help" }
  | {
      kind: "start";
      request: Omit<BrokerReviewStartRequest, "boxId">;
      wait: boolean;
      json: boolean;
    }
  | { kind: "status"; runId: string; wait: boolean; json: boolean };

/** Parses the arguments; throws an `Error` whose message explains a usage error. */
export function parseBoxReviewArgs(argv: readonly string[]): BoxReviewCommand {
  const [first, ...rest] = argv;
  if (first === undefined) throw new Error("Name a request: start or status.");
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first !== "start" && first !== "status") throw new Error(`${first} isn't a request.`);
  const request: Omit<BrokerReviewStartRequest, "boxId"> = {};
  const positional: string[] = [];
  let wait = first === "start";
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const value = (): string => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.`);
      i += 1;
      return v;
    };
    if (arg === "--json") json = true;
    else if (arg === "--wait" && first === "status") wait = true;
    else if (arg === "--no-wait" && first === "start") wait = false;
    else if (first === "start" && arg === "--base") request.base = value();
    else if (first === "start" && arg === "--branch") request.branch = value();
    else if (first === "start" && arg === "--read-only") request.readOnly = true;
    else if (first === "start" && arg === "--profile") {
      const v = value();
      const parsed = ProfileSchema.safeParse(v);
      if (!parsed.success) throw new Error(`--profile takes offload, balanced, or fast, not ${v}.`);
      request.profile = parsed.data;
    } else if (first === "start" && arg === "--depth") {
      const v = value();
      const parsed = RunDepthSchema.safeParse(v);
      if (!parsed.success) throw new Error(`--depth takes standard or thorough, not ${v}.`);
      request.depth = parsed.data;
    } else if (arg.startsWith("--")) throw new Error(`${first} doesn't take ${arg}.`);
    else positional.push(arg);
  }
  if (first === "start") {
    if (positional.length > 0) throw new Error("start takes no arguments, only options.");
    return { kind: "start", request, wait, json };
  }
  if (positional.length !== 1) throw new Error("status needs one run ID.");
  return { kind: "status", runId: positional[0]!, wait, json };
}

function location(f: Finding): string {
  if (f.file === null) return "";
  if (f.lines === null) return ` ${f.file}`;
  const [from, to] = f.lines;
  return ` ${f.file}:${from === to ? from : `${from}-${to}`}`;
}

/** The result as text: the outcome, then one line per confirmed or fixed finding. */
export function formatResult({ run, findings }: BrokerReviewRunResponse): string {
  const lines: string[] = [];
  if (run.status === "finished") {
    lines.push(`Run ${run.id} finished: ${run.stopReason ?? "no stop reason"}.`);
  } else if (run.status === "waiting_decision") {
    lines.push(
      `Run ${run.id} waits for a decision${run.stopReason ? ` (${run.stopReason})` : ""}. Ask the owner to answer it in the Review app.`,
    );
  } else if (ENDED.has(run.status)) {
    lines.push(`Run ${run.id} ${run.status}${run.stopReason ? `: ${run.stopReason}` : ""}.`);
  } else {
    lines.push(`Run ${run.id} is ${run.status}, at the ${run.stage} stage of round ${run.round}.`);
  }
  if (run.error) lines.push(run.error);
  const reported = findings.filter((f) => REPORTED.has(f.verdict));
  lines.push(`Confirmed findings: ${reported.length}.`);
  for (const f of reported) {
    lines.push(`  ${f.id} ${f.severity} ${f.verdict}${location(f)} ${f.title}`);
  }
  return `${lines.join("\n")}\n`;
}

function exitCodeFor(run: RunState): number {
  if (run.status === "finished") return 0;
  if (run.status === "waiting_decision") return 6;
  if (ENDED.has(run.status)) return 1;
  return 0;
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `aio-box-review` and returns its exit status. */
export async function boxReviewMain(argv: readonly string[], io: BoxReviewCliIo): Promise<number> {
  let command: BoxReviewCommand;
  try {
    command = parseBoxReviewArgs(argv);
  } catch (err) {
    io.stderr(`aio-box-review: ${(err as Error).message}\n\n${BOX_REVIEW_USAGE}`);
    return 2;
  }
  if (command.kind === "help") {
    io.stdout(BOX_REVIEW_USAGE);
    return 0;
  }
  const boxId = io.env[BUILD_SOCKET_ENV.boxId];
  if (!boxId) {
    io.stderr(
      `aio-box-review: ${BUILD_SOCKET_ENV.boxId} isn't set. Run aio-box-review in a box session, which the server gives the box's ID.\n`,
    );
    return 2;
  }
  const sleep = io.sleep ?? timer;
  try {
    const client = io.client ?? new BrokerClient({ env: io.env });
    let runId: string;
    if (command.kind === "start") {
      const run = await client.startReview({ boxId, ...command.request });
      runId = run.id;
      io.stderr(
        `Started review run ${run.id} of ${run.request.tip ?? "the checked-out branch"}.\n`,
      );
      if (!command.wait) {
        io.stdout(command.json ? `${JSON.stringify(run, null, 2)}\n` : `${run.id}\n`);
        return 0;
      }
    } else {
      runId = command.runId;
    }
    let result = await client.reviewRun(runId, boxId);
    let last = "";
    while (command.wait && !ENDED.has(result.run.status)) {
      if (result.run.status === "waiting_decision") break;
      const now = `${result.run.status}, ${result.run.stage}, round ${result.run.round}`;
      if (now !== last) io.stderr(`Run ${runId}: ${now}.\n`);
      last = now;
      await sleep(POLL_MS);
      result = await client.reviewRun(runId, boxId);
    }
    io.stdout(command.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
    return exitCodeFor(result.run);
  } catch (err) {
    if (err instanceof BrokerError) {
      io.stderr(`aio-box-review: ${err.message}\n`);
      if (err.code === "unreachable" || err.code === "unsupported" || err.code === "protocol") {
        return 3;
      }
      return REFUSED.has(err.code) ? 4 : 1;
    }
    io.stderr(`aio-box-review: ${(err as Error).message}\n`);
    return 1;
  }
}

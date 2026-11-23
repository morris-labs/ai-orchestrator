// The agent call for one turn of a seat: the role's prompt and permission,
// the seat's placement, and the task's specialties. Execution steps and
// planning seats build their calls here, so every seat's call names its
// seat and step the same way.
import type { AgentRole, BuildStep, RoleDefinition, RoleName, SeatPlacement } from "@aio/contracts";
import { z } from "zod";
import type { AgentCallSpec } from "../calls/index.js";
import type { AdapterOutput } from "../core.js";
import { placeCall } from "./placements/index.js";
import { roleAnswerSchema, rolePrompt, type RoleTask } from "./roles/index.js";
import { specialtyCall, type SpecialtyPack } from "./specialties/index.js";

/** The lease estimate of one seat's turn, in tokens. */
export const SEAT_ESTIMATE_TOKENS = 100_000;

/** A role's answer: a JSON object, which the step that asked reads. */
const RoleAnswerSchema = z.record(z.unknown());

/**
 * The review role that a seat's leases and events name, until they name the
 * seat itself (ADR 0007): a seat that writes files is a `fixer`, and a
 * read-only seat a `reviewer`.
 */
export function agentRoleFor(role: RoleDefinition): AgentRole {
  return role.permission.access === "write" ? "fixer" : "reviewer";
}

/** What one seat turn needs beyond its role and placement. */
export interface SeatTurn {
  seat: RoleName;
  /** Unique in the build; a finished call with this key is never made again. */
  key: string;
  step: BuildStep;
  task: RoleTask;
  /** The folder the agent works in. */
  repoPath: string;
  /** Scratch space for the agent. */
  scratchDir: string;
  /** The task's specialty packs. */
  specialties?: readonly SpecialtyPack[];
  /** The prompt, when the caller wrote one. Default: the role prompt for the task. */
  prompt?: string;
  /** The answer's shape. Default: the role's answer schema. */
  output?: AdapterOutput;
  /** The session to resume. Absent, the turn starts a fresh agent. */
  sessionId?: string;
}

/** The agent call for one turn of `role`'s seat on `placement`. */
export function seatCallSpec(
  role: RoleDefinition,
  placement: SeatPlacement,
  turn: SeatTurn,
): AgentCallSpec {
  const writes = role.permission.access === "write";
  const packs = turn.specialties ?? [];
  return placeCall(
    specialtyCall(
      {
        key: turn.key,
        role: agentRoleFor(role),
        method: writes ? "fix" : "review",
        request: {
          prompt: turn.prompt ?? rolePrompt(role, { ...turn.task, specialties: packs }),
          repoPath: turn.repoPath,
          toolPolicy: writes ? "write" : "read-only",
          scratchDir: turn.scratchDir,
          timeoutMs: role.turnTimeoutMinutes * 60_000,
          output: turn.output ?? {
            schema: RoleAnswerSchema,
            json: (roleAnswerSchema(role) as Record<string, unknown> | null) ?? {
              type: "object",
            },
          },
          ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
        },
        groupId: null,
        estimateTokens: SEAT_ESTIMATE_TOKENS,
        seat: turn.seat,
        step: turn.step,
      },
      packs,
    ),
    placement,
  );
}

// Specialties reach every agent on a task, on any vendor, and the agent
// calls name them so usage breaks down by specialty.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Placement, Vendor } from "@aio/contracts";
import type { AdapterRequest, AdapterResult, EventDraft, VendorAdapter } from "../../src/core.js";
import { loadRole, rolePrompt, type RoleTask } from "../../src/build/roles/index.js";
import { SeatPlacements, placeCall } from "../../src/build/placements/index.js";
import {
  loadSpecialties,
  specialtyCall,
  type SpecialtyPack,
} from "../../src/build/specialties/index.js";
import { buildSampleRepo } from "../state/scenario.js";
import { makeCaller, type Answer } from "../calls/caller.js";
import { tempDir } from "../tmp.js";

/** An adapter that answers `fix` calls and keeps each request it got. */
function recording(vendor: Vendor): VendorAdapter & { requests: AdapterRequest[] } {
  const requests: AdapterRequest[] = [];
  const adapter = {
    vendor,
    requests,
    fix: (request: AdapterRequest): Promise<AdapterResult<Answer>> => {
      requests.push(request);
      return Promise.resolve({
        output: { text: "done" },
        model: `${vendor}-model`,
        sessionId: "s-1",
        tokens: { in: 10, out: 5 },
        usage: [],
        premiumRequests: 0,
        costEstimate: 0.01,
      });
    },
    detectLimit: () => null,
  };
  return adapter as unknown as VendorAdapter & { requests: AdapterRequest[] };
}

const task: RoleTask = {
  id: "T1",
  title: "Add the export command",
  description: "Add an export command.",
  repoPath: "/repo",
  branch: "build/add-export/T1",
  ownedFiles: ["src/export.ts"],
  criteria: [{ id: "AC1", text: "The command writes a CSV file." }],
};

const roles = new Map<string, { placement: Placement }>([
  ["developer", { placement: { vendor: "claude", tier: "large", effort: "medium" } }],
  ["test-engineer", { placement: { vendor: "codex", tier: "large", effort: "medium" } }],
]);

function ofType<T extends EventDraft["type"]>(events: EventDraft[], type: T) {
  return events.filter((e): e is Extract<EventDraft, { type: T }> => e.type === type);
}

async function packs(): Promise<SpecialtyPack[]> {
  const root = tempDir("aio-specialty-calls-");
  const skills = join(root, "skills");
  mkdirSync(join(skills, "node-dev"), { recursive: true });
  writeFileSync(
    join(skills, "node-dev", "SKILL.md"),
    "---\nname: node-dev\ndescription: Node.js.\n---\n\nPrefer node:fs/promises over callbacks.\n",
  );
  mkdirSync(join(root, "repo", ".aio", "team", "specialties"), { recursive: true });
  writeFileSync(
    join(root, "repo", ".aio", "team", "specialties", "csv.md"),
    "Quote every field that holds a comma.",
  );
  return loadSpecialties(["node-dev", "csv"], {
    repoRoot: join(root, "repo"),
    skillDirs: [skills],
  });
}

describe("specialties in agent calls", () => {
  it("puts each specialty's text in the role prompt", async () => {
    const developer = await loadRole("developer", "/nonexistent");
    const prompt = rolePrompt(developer, { ...task, specialties: await packs() });

    expect(prompt).toContain("## Specialties");
    expect(prompt).toContain("Prefer node:fs/promises over callbacks.");
    expect(prompt).toContain("Quote every field that holds a comma.");
    expect(prompt.indexOf("## Specialties")).toBeLessThan(prompt.indexOf("## Task T1"));
  });

  it("leaves the section out for a task with no specialties", async () => {
    const developer = await loadRole("developer", "/nonexistent");
    expect(rolePrompt(developer, task)).not.toContain("## Specialties");
  });

  it("gives a Claude agent and a Codex agent on one task the same specialty text", async () => {
    const repo = buildSampleRepo();
    const developer = await loadRole("developer", "/nonexistent");
    const loaded = await packs();
    const claude = recording("claude");
    const codex = recording("codex");
    const { calls, emitted, broker } = makeCaller({ claude, codex });
    const seats = new SeatPlacements(roles, {});

    for (const seat of ["developer", "test-engineer"]) {
      const prompt = rolePrompt(developer, { ...task, repoPath: repo, specialties: loaded });
      const call = specialtyCall(
        {
          key: `T1-${seat}`,
          role: "fixer",
          method: "fix",
          request: { prompt, repoPath: repo, toolPolicy: "write" },
          groupId: null,
          estimateTokens: 100,
          seat,
          step: "tasks",
        },
        loaded,
      );
      await calls.call<Answer>(placeCall(call, seats.place(seat)));
    }

    for (const adapter of [claude, codex]) {
      expect(adapter.requests).toHaveLength(1);
      expect(adapter.requests[0]?.prompt).toContain("Prefer node:fs/promises over callbacks.");
      expect(adapter.requests[0]?.prompt).toContain("Quote every field that holds a comma.");
    }
    // The agent can read files that an account skill refers to.
    expect(codex.requests[0]?.extraDirs).toContain(loaded[0]?.dir);
    // The lease, the agent events, and the settlement name the specialties.
    const names = ["node-dev", "csv"];
    expect(broker.requests.map((r) => r.specialties)).toEqual([names, names]);
    expect(ofType(emitted, "agent.started").map((e) => e.specialties)).toEqual([names, names]);
    expect(ofType(emitted, "agent.finished").map((e) => e.specialties)).toEqual([names, names]);
    expect(ofType(emitted, "lease.settled").map((e) => [e.vendor, e.specialties])).toEqual([
      ["claude", names],
      ["codex", names],
    ]);
  });

  it("names no specialties on a call whose task has none", async () => {
    const repo = buildSampleRepo();
    const { calls, emitted } = makeCaller({ codex: recording("codex") });
    const seats = new SeatPlacements(roles, {});

    const call = specialtyCall(
      {
        key: "T2",
        role: "fixer",
        method: "fix",
        request: { prompt: "Write it.", repoPath: repo, toolPolicy: "write" },
        groupId: null,
        estimateTokens: 100,
      },
      [],
    );
    await calls.call<Answer>(placeCall(call, seats.place("test-engineer")));

    expect(ofType(emitted, "lease.settled")[0]).not.toHaveProperty("specialties");
  });
});

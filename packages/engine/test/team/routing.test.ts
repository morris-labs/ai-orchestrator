// Routing rules of the team chat: where a message goes when its sender names
// no addressee, and how a named addressee is kept.
import { describe, expect, it } from "vitest";
import { routeMessage, taskOwning, type RouteTask } from "../../src/team/index.js";

const tasks: RouteTask[] = [
  { id: "T1", role: "developer", ownedFiles: ["src/cart.mjs"] },
  { id: "T2", role: "developer", ownedFiles: ["src/tax/**"] },
  { id: "T3", role: "frontend-developer", ownedFiles: ["web/*.tsx"] },
];
const sender = { kind: "seat", seat: "developer", taskId: "T1" } as const;

describe("routing a message without an addressee", () => {
  it("sends a test dispute to the Test engineer of the message's task", () => {
    expect(routeMessage({ type: "test_dispute", body: "x" }, sender, tasks)).toEqual({
      to: { kind: "seat", seat: "test-engineer", taskId: "T1" },
      routing: "by_type",
    });
    expect(
      routeMessage({ type: "test_dispute", body: "x", taskId: "T2" }, sender, tasks).to,
    ).toEqual({ kind: "seat", seat: "test-engineer", taskId: "T2" });
  });

  it("sends a file request to the Developer of the task that owns the file", () => {
    const route = (paths: string[]) =>
      routeMessage({ type: "file_request", body: "x", paths }, sender, tasks);
    expect(route(["src/tax/rates.mjs"])).toEqual({
      to: { kind: "seat", seat: "developer", taskId: "T2" },
      routing: "by_type",
    });
    // The owning task's own role fills the Developer's place.
    expect(route(["web/Cart.tsx"]).to).toEqual({
      kind: "seat",
      seat: "frontend-developer",
      taskId: "T3",
    });
    // The first file that a task owns decides.
    expect(route(["README.md", "src/cart.mjs"]).to).toEqual({
      kind: "seat",
      seat: "developer",
      taskId: "T1",
    });
  });

  it("sends a file request for files no task owns to the Project manager", () => {
    expect(
      routeMessage({ type: "file_request", body: "x", paths: ["README.md"] }, sender, tasks).to,
    ).toEqual({ kind: "seat", seat: "project-manager", taskId: null });
  });

  it("sends a contract question to the Architect", () => {
    expect(routeMessage({ type: "contract_question", body: "x" }, sender, tasks).to).toEqual({
      kind: "seat",
      seat: "architect",
      taskId: null,
    });
  });

  it("sends every other type to the Project manager", () => {
    for (const type of [
      "question",
      "answer",
      "bug_report",
      "handoff",
      "meeting_reply",
      "note",
    ] as const) {
      expect(routeMessage({ type, body: "x" }, sender, tasks)).toEqual({
        to: { kind: "seat", seat: "project-manager", taskId: null },
        routing: "by_type",
      });
    }
  });
});

describe("routing a message with an addressee", () => {
  it("keeps the named seat and task, whatever the type", () => {
    expect(
      routeMessage({ type: "test_dispute", body: "x", to: "architect" }, sender, tasks),
    ).toEqual({ to: { kind: "seat", seat: "architect", taskId: null }, routing: "addressed" });
    expect(
      routeMessage({ type: "question", body: "x", to: "developer", toTask: "T2" }, sender, tasks)
        .to,
    ).toEqual({ kind: "seat", seat: "developer", taskId: "T2" });
  });

  it("addresses the owner by name", () => {
    expect(routeMessage({ type: "note", body: "x", to: "owner" }, sender, tasks)).toEqual({
      to: { kind: "owner" },
      routing: "addressed",
    });
  });
});

describe("taskOwning", () => {
  it("finds the task whose owned files cover a path", () => {
    expect(taskOwning(tasks, "src/tax/rates/eu.mjs")?.id).toBe("T2");
    expect(taskOwning(tasks, "src/other.mjs")).toBeNull();
  });
});

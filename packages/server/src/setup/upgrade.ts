// One upgrade coordinator for package installs, startup recovery and CLI updates.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { UpgradePreviewSchema, type UpgradePreview, type UpgradeReport } from "@aio/contracts";
import type { Core } from "../api/core-interface.js";

const RecordSchema = UpgradePreviewSchema.extend({
  runs: z.array(z.object({ run_id: z.string(), name: z.string(), projectId: z.string() })),
  phase: z.enum(["prepared", "recovery"]).default("prepared"),
});
type OpenWork = z.infer<typeof RecordSchema>;

/** Reports whether an error says the box or run no longer exists. */
function isGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "not_found" || code === "run_not_found";
}
export interface UpgradeOptions {
  core: Core;
  recordFile: string;
  build(signal?: AbortSignal): Promise<"latest" | "pinned">;
  runs(): { id: string; projectId: string; status: string }[];
  resume(projectId: string, runId: string, signal?: AbortSignal): Promise<void>;
  timeoutMs?: number;
  log?: (message: string) => void;
}
export class UpgradeService {
  private active: Promise<UpgradeReport> | null = null;
  constructor(private readonly opts: UpgradeOptions) {}
  get hasOpenWork(): boolean {
    return fs.existsSync(this.opts.recordFile);
  }
  get upgrading(): boolean {
    return this.active !== null;
  }
  async waitReady(): Promise<void> {
    const report = await this.active;
    if (report?.error) throw new Error(report.error);
  }
  async preview(): Promise<UpgradePreview> {
    const work = await this.snapshot();
    return { boxes: work.boxes, runs: work.runs.map(({ run_id, name }) => ({ run_id, name })) };
  }
  private async snapshot(): Promise<OpenWork> {
    return {
      phase: "prepared",
      boxes: (await this.opts.core.boxes.list({}))
        .filter((b) => b.status === "running")
        .map((b) => ({ id: b.box.id, name: b.box.conversationName || b.box.id })),
      runs: this.opts
        .runs()
        .filter((r) => ["pending", "running", "waiting_decision"].includes(r.status))
        .map((r) => ({ run_id: r.id, name: r.id, projectId: r.projectId })),
    };
  }
  async prepare(): Promise<UpgradePreview> {
    const existing = this.hasOpenWork ? this.readRecord() : null;
    const work = await this.snapshot();
    if (existing) {
      work.boxes = [
        ...existing.boxes,
        ...work.boxes.filter((box) => !existing.boxes.some((b) => b.id === box.id)),
      ];
      work.runs = [
        ...existing.runs,
        ...work.runs.filter((run) => !existing.runs.some((r) => r.run_id === run.run_id)),
      ];
    }
    this.writeRecord(work);
    return { boxes: work.boxes, runs: work.runs.map(({ run_id, name }) => ({ run_id, name })) };
  }
  /**
   * Drops a box or run from the open-work record, so an upgrade doesn't
   * bring back work that the owner stopped, cancelled, or removed.
   */
  forget(item: { boxId?: string; runId?: string; allBoxes?: boolean }): void {
    if (!this.hasOpenWork) return;
    let work: OpenWork;
    try {
      work = this.readRecord();
    } catch {
      return;
    }
    const boxes = work.boxes.filter((box) => !item.allBoxes && box.id !== item.boxId);
    const runs = work.runs.filter((run) => run.run_id !== item.runId);
    if (boxes.length === work.boxes.length && runs.length === work.runs.length) return;
    this.writeRecord({ ...work, boxes, runs });
  }
  private readRecord(): OpenWork {
    return RecordSchema.parse(JSON.parse(fs.readFileSync(this.opts.recordFile, "utf8")));
  }
  private writeRecord(work: OpenWork): void {
    fs.mkdirSync(path.dirname(this.opts.recordFile), { recursive: true });
    const tmp = `${this.opts.recordFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(work), { mode: 0o600 });
    fs.renameSync(tmp, this.opts.recordFile);
  }
  start(): Promise<UpgradeReport> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async run(): Promise<UpgradeReport> {
    if (!this.hasOpenWork) await this.prepare();
    const work = this.readRecord();
    const controller = new AbortController();
    const deadline = Date.now() + (this.opts.timeoutMs ?? 300_000);
    const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(new Error("Upgrade time limit reached"));
              },
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const report: UpgradeReport = {
      image: "failed",
      fallback: false,
      error: null,
      boxes: [],
      runs: [],
    };
    const failures = new Map<string, string>();
    if (work.phase === "prepared") {
      this.opts.log?.("Upgrading: building the image");
      try {
        report.image = await withinDeadline(this.opts.build(controller.signal));
        report.fallback = report.image === "pinned";
      } catch (err) {
        report.error = String((err as Error).message);
        report.boxes = work.boxes.map((box) => ({ ...box, restored: false, reason: report.error }));
        report.runs = work.runs.map((run) => ({
          run_id: run.run_id,
          name: run.name,
          restored: false,
          reason: report.error,
        }));
        return report;
      }
      const current = await this.snapshot();
      work.boxes.push(...current.boxes.filter((box) => !work.boxes.some((b) => b.id === box.id)));
      work.runs.push(
        ...current.runs.filter((run) => !work.runs.some((r) => r.run_id === run.run_id)),
      );
      work.phase = "recovery";
      this.writeRecord(work);
      for (const { project } of await this.opts.core.projects.list()) {
        try {
          if (Date.now() >= deadline) throw new Error("Upgrade time limit reached");
          if (!this.opts.core.projects.recreateContainer)
            throw new Error("Container recreation is unavailable");
          await withinDeadline(this.opts.core.projects.recreateContainer(project.id));
        } catch (err) {
          failures.set(project.id, String((err as Error).message));
        }
      }
    } else {
      report.image = "latest";
    }
    for (const box of [...work.boxes]) {
      let reason: string | null = null;
      let gone = false;
      try {
        if (Date.now() >= deadline) throw new Error("Upgrade time limit reached");
        const current = await this.opts.core.boxes.get(box.id);
        const failure = failures.get(current.box.projectId);
        if (failure) throw new Error(failure);
        await withinDeadline(this.opts.core.boxes.start(box.id));
      } catch (err) {
        reason = isGone(err) ? "The box no longer exists." : String((err as Error).message);
        gone = isGone(err);
      }
      report.boxes.push({ ...box, restored: reason === null, reason, ...(gone ? { gone } : {}) });
      if (reason === null || gone) {
        work.boxes = work.boxes.filter((item) => item.id !== box.id);
        this.writeRecord(work);
      }
    }
    for (const { projectId, ...run } of [...work.runs]) {
      let reason: string | null = null;
      let gone = false;
      try {
        if (Date.now() >= deadline) throw new Error("Upgrade time limit reached");
        const failure = failures.get(projectId);
        if (failure) throw new Error(failure);
        await withinDeadline(this.opts.resume(projectId, run.run_id, controller.signal));
      } catch (err) {
        reason = isGone(err) ? "The run no longer exists." : String((err as Error).message);
        gone = isGone(err);
      }
      report.runs.push({ ...run, restored: reason === null, reason, ...(gone ? { gone } : {}) });
      if (reason === null || gone) {
        work.runs = work.runs.filter((item) => item.run_id !== run.run_id);
        this.writeRecord(work);
      }
    }
    // A project without open work must still be represented in a failed summary.
    if (failures.size)
      report.error = [...failures].map(([id, reason]) => `${id}: ${reason}`).join("; ");
    // Work that no longer exists has left the record and doesn't keep it.
    if (!work.boxes.length && !work.runs.length && !report.error) {
      fs.rmSync(this.opts.recordFile, { force: true });
    }
    this.opts.log?.(
      `Upgrade finished: ${report.boxes.filter((b) => b.restored).length} boxes and ${report.runs.filter((r) => r.restored).length} runs restored${report.fallback ? "; used pinned CLI versions" : ""}`,
    );
    return report;
  }
}

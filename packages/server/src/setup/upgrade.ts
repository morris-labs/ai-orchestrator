// One upgrade coordinator for package installs, startup recovery and CLI updates.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { UpgradePreviewSchema, type UpgradePreview, type UpgradeReport } from "@aio/contracts";
import type { Core } from "../api/core-interface.js";

const RecordSchema = UpgradePreviewSchema.extend({
  runs: z.array(z.object({ run_id: z.string(), name: z.string(), projectId: z.string() })),
  phase: z.enum(["prepared", "recovery"]).default("prepared"),
  /**
   * Projects whose containers the upgrade recreated on the built image. A
   * record from an older version has none, and its recovery recreates nothing.
   */
  recreated: z.array(z.string()).optional(),
});
type OpenWork = z.infer<typeof RecordSchema>;

/** Reports whether an error says the box or run no longer exists. */
function isGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "not_found" || code === "run_not_found";
}
/**
 * Saves an upgrade's image build output to `file`, readable by its owner
 * only, so a failed build leaves its log behind. Returns false when the
 * file can't be written.
 */
export function saveImageBuildLog(file: string, output: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, output, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The error for a failed upgrade image build: the last line the build
 * printed, which usually names the cause, and where the full log is.
 */
export function imageBuildFailureMessage(
  output: string,
  file: string | null,
  fallback: string,
): string {
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const cause = last ? `The image build failed: ${last}` : fallback;
  return file ? `${cause.replace(/\.$/, "")}. The full build log is in ${file}.` : cause;
}

/** How long an image build can go without output before the upgrade stops it. */
export const DEFAULT_BUILD_STALL_MS = 600_000;
/** The restore time every upgrade gets, plus the time per project, box, and run. */
export const RESTORE_BASE_MS = 120_000;
export const RESTORE_PER_ITEM_MS = 60_000;

export interface UpgradeOptions {
  core: Core;
  recordFile: string;
  /**
   * Builds the image. The build calls `progress` with each line of output;
   * a build that stays silent for `buildStallMs` is stopped.
   */
  build(signal?: AbortSignal, progress?: (line: string) => void): Promise<"latest" | "pinned">;
  runs(): { id: string; projectId: string; status: string }[];
  resume(projectId: string, runId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Whether the image already carries the engine this server expects. A
   * retry after a successful build skips the build when it does.
   */
  imageCurrent?(): Promise<boolean>;
  /** Default: `DEFAULT_BUILD_STALL_MS`. */
  buildStallMs?: number;
  /**
   * The time for recreating containers and restoring boxes and runs.
   * Default: `RESTORE_BASE_MS` plus `RESTORE_PER_ITEM_MS` for each project,
   * box, and run.
   */
  restoreTimeoutMs?: number;
  log?: (message: string) => void;
}
export class UpgradeService {
  private active: Promise<UpgradeReport> | null = null;
  private currentStage: "building" | "restoring" | null = null;
  private lastBuildLine: string | null = null;
  constructor(private readonly opts: UpgradeOptions) {}
  /** What a running upgrade is doing, or null when none runs. */
  get stage(): "building" | "restoring" | null {
    return this.active ? this.currentStage : null;
  }
  /** The last line the running upgrade's image build printed. */
  get buildLine(): string | null {
    return this.stage === "building" ? this.lastBuildLine : null;
  }
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
      // A retry after a successful build keeps its place, so it doesn't build
      // again or recreate the containers it already recreated.
      work.phase = existing.phase;
      if (existing.recreated) work.recreated = existing.recreated;
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
  /**
   * Runs the image build for as long as it keeps printing, and stops it once
   * it stays silent for the stall window.
   */
  private async buildWatched(): Promise<"latest" | "pinned"> {
    const stallMs = this.opts.buildStallMs ?? DEFAULT_BUILD_STALL_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled: (err: Error) => void = () => {};
    const stall = new Promise<never>((_, reject) => {
      stalled = reject;
    });
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort();
        const minutes = Math.round(stallMs / 60_000);
        stalled(
          new Error(
            `The image build printed nothing for ${minutes >= 1 ? `${minutes} minutes` : `${stallMs} ms`}, so the upgrade stopped it.`,
          ),
        );
      }, stallMs);
    };
    const progress = (line: string) => {
      const text = line.trim();
      if (text) this.lastBuildLine = text;
      arm();
    };
    arm();
    try {
      return await Promise.race([this.opts.build(controller.signal, progress), stall]);
    } finally {
      clearTimeout(timer);
    }
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
      this.currentStage = null;
      this.lastBuildLine = null;
    });
    return this.active;
  }
  private async run(): Promise<UpgradeReport> {
    if (!this.hasOpenWork) await this.prepare();
    const work = this.readRecord();
    const report: UpgradeReport = {
      image: "failed",
      fallback: false,
      error: null,
      boxes: [],
      runs: [],
    };
    if (work.phase === "recovery" && this.opts.imageCurrent && !(await this.opts.imageCurrent())) {
      // The record outlived its build: a newer package needs a new image.
      work.phase = "prepared";
      delete work.recreated;
    }
    if (work.phase === "prepared") {
      this.currentStage = "building";
      this.opts.log?.("Upgrading: building the image");
      try {
        report.image = await this.buildWatched();
        report.fallback = report.image === "pinned";
      } catch (err) {
        report.error = String((err as Error).message);
        // The error appears once in the report; each item points back to it.
        const reason = "Not restored, because the image build failed.";
        report.boxes = work.boxes.map((box) => ({ ...box, restored: false, reason }));
        report.runs = work.runs.map((run) => ({
          run_id: run.run_id,
          name: run.name,
          restored: false,
          reason,
        }));
        return report;
      }
      const current = await this.snapshot();
      work.boxes.push(...current.boxes.filter((box) => !work.boxes.some((b) => b.id === box.id)));
      work.runs.push(
        ...current.runs.filter((run) => !work.runs.some((r) => r.run_id === run.run_id)),
      );
      work.phase = "recovery";
      work.recreated = [];
      this.writeRecord(work);
    } else {
      report.image = "latest";
    }

    this.currentStage = "restoring";
    const projects = await this.opts.core.projects.list();
    const toRecreate = work.recreated
      ? projects.filter(({ project }) => !work.recreated?.includes(project.id))
      : [];
    const controller = new AbortController();
    const deadline =
      Date.now() +
      (this.opts.restoreTimeoutMs ??
        RESTORE_BASE_MS +
          RESTORE_PER_ITEM_MS * (toRecreate.length + work.boxes.length + work.runs.length));
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
    const failures = new Map<string, string>();
    for (const { project } of toRecreate) {
      try {
        if (Date.now() >= deadline) throw new Error("Upgrade time limit reached");
        if (!this.opts.core.projects.recreateContainer)
          throw new Error("Container recreation is unavailable");
        await withinDeadline(this.opts.core.projects.recreateContainer(project.id));
        work.recreated = [...(work.recreated ?? []), project.id];
        this.writeRecord(work);
      } catch (err) {
        failures.set(project.id, String((err as Error).message));
      }
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
        // A box whose session kept running, as on a retry that didn't
        // recreate its container, is already where the restore would put it.
        if ((err as { code?: unknown } | null)?.code !== "box_running") {
          reason = isGone(err) ? "The box no longer exists." : String((err as Error).message);
          gone = isGone(err);
        }
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

// Named SSH remotes and the box references to them. W2 runs the tunnels.
import { SshRemoteInputSchema, type SshRemote } from "@agentbox/contracts";
import type { z } from "zod";
import type { Repositories } from "../db/repositories.js";
import type { HostEnv } from "./env.js";
import { ApiError, notFound } from "./errors.js";

export interface SshRemoteRecordView {
  remote: SshRemote;
  /** Boxes whose `sshRemoteRefs` name this remote. */
  referencedBy: string[];
}

export class SshRemoteService {
  constructor(
    private readonly env: HostEnv,
    private readonly repos: Repositories,
  ) {}

  private referencedBy(name: string): string[] {
    return this.repos.boxes
      .list()
      .filter((b) => b.sshRemoteRefs.includes(name))
      .map((b) => b.id);
  }

  list(): SshRemoteRecordView[] {
    return this.repos.sshRemotes
      .list()
      .map((remote) => ({ remote, referencedBy: this.referencedBy(remote.name) }));
  }

  get(name: string): SshRemoteRecordView {
    const remote = this.repos.sshRemotes.get(name) ?? notFound(`The SSH remote "${name}"`);
    return { remote, referencedBy: this.referencedBy(name) };
  }

  /**
   * Creates or replaces the remote `name`. A different `name` in the body
   * renames it and rewrites every box reference.
   */
  put(name: string, input: z.input<typeof SshRemoteInputSchema>): SshRemoteRecordView {
    const parsed = SshRemoteInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError("validation", parsed.error.issues[0]?.message ?? "invalid remote");
    const remote = parsed.data;
    const now = this.env.now().toISOString();
    this.repos.transaction(() => {
      if (remote.name !== name) {
        if (this.repos.sshRemotes.get(remote.name)) {
          throw new ApiError("conflict", `An SSH remote named "${remote.name}" already exists.`);
        }
        if (this.repos.sshRemotes.get(name)) {
          this.repos.sshRemotes.delete(name);
          for (const box of this.repos.boxes.list()) {
            if (!box.sshRemoteRefs.includes(name)) continue;
            this.repos.boxes.put({
              ...box,
              sshRemoteRefs: box.sshRemoteRefs.map((r) => (r === name ? remote.name : r)),
              updatedAt: now,
            });
          }
        }
      }
      this.repos.sshRemotes.put(remote);
    });
    return this.get(remote.name);
  }

  /** Deletes a remote and drops it from every box; returns those boxes. */
  delete(name: string): { unlinkedBoxes: string[] } {
    if (!this.repos.sshRemotes.get(name)) notFound(`The SSH remote "${name}"`);
    const now = this.env.now().toISOString();
    const unlinked: string[] = [];
    this.repos.transaction(() => {
      this.repos.sshRemotes.delete(name);
      for (const box of this.repos.boxes.list()) {
        if (!box.sshRemoteRefs.includes(name)) continue;
        unlinked.push(box.id);
        this.repos.boxes.put({
          ...box,
          sshRemoteRefs: box.sshRemoteRefs.filter((r) => r !== name),
          updatedAt: now,
        });
      }
    });
    return { unlinkedBoxes: unlinked };
  }
}

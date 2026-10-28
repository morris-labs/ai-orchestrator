// Repository and ref lookups for the run launcher, through the server's
// `projects.repos.list` and `projects.repos.refs` routes, which proxy the
// project's engine. When the engine can't answer (its container isn't
// running, or an older server lacks the routes), the launcher falls back to
// the project's primary repository with free-text refs.
import type { ProjectSummary, RepoInfoSchema, RepoRefsSchema } from "@agentbox/contracts";
import { ApiRequestError, type ApiClient } from "@agentbox/ui/core";
import type { z } from "zod";

export type RepoInfo = z.infer<typeof RepoInfoSchema>;
export type RepoRefs = z.infer<typeof RepoRefsSchema>;

export const EMPTY_REFS: RepoRefs = {
  localBranches: [],
  remoteBranches: [],
  tags: [],
  recentCommits: [],
  pullRequests: [],
};

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** The repositories the launcher offers when the server can't list them. */
export function fallbackRepos(summary: ProjectSummary): RepoInfo[] {
  const path = summary.project.primaryRepo ?? summary.project.root;
  return [{ path, name: basename(path), currentBranch: null, headSha: null, dirty: false }];
}

/** True for the failures the fallback covers: a missing route or an engine that isn't up. */
export function engineUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  return [404, 405, 502, 503].includes(err.status) || err.code === "unreachable";
}

export async function listRepos(
  api: ApiClient,
  summary: ProjectSummary,
): Promise<{ repos: RepoInfo[]; fromServer: boolean }> {
  try {
    const { repos } = await api.call("projects.repos.list", {
      params: { projectId: summary.project.id },
    });
    return { repos, fromServer: true };
  } catch (err) {
    if (engineUnavailable(err)) return { repos: fallbackRepos(summary), fromServer: false };
    throw err;
  }
}

export async function listRefs(
  api: ApiClient,
  projectId: string,
  repo: string,
): Promise<{ refs: RepoRefs; fromServer: boolean }> {
  try {
    const refs = await api.call("projects.repos.refs", { params: { projectId }, query: { repo } });
    return { refs, fromServer: true };
  } catch (err) {
    if (engineUnavailable(err)) return { refs: EMPTY_REFS, fromServer: false };
    throw err;
  }
}

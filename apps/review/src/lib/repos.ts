// Repository and ref lookups for the run launcher.
//
// The engine has `engine.repos.list` and `engine.repos.refs`, but the server
// route table has no proxy for them yet (requested in the W7 report). This
// adapter calls the proposed server routes,
// `GET /api/v1/projects/:projectId/repos` and
// `GET /api/v1/projects/:projectId/repos/refs?repo=`, validates the answers
// with the engine's schemas, and falls back to the project's primary
// repository with free-text refs when the server doesn't have them.
import { RepoInfoSchema, RepoRefsSchema, type ProjectSummary } from "@agentbox/contracts";
import { z } from "zod";
import { ApiCallError, type ApiClient } from "./api.js";

export type RepoInfo = z.infer<typeof RepoInfoSchema>;
export type RepoRefs = z.infer<typeof RepoRefsSchema>;

export const PROPOSED_REPOS_PATH = (projectId: string) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/repos`;

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

function missingRoute(err: unknown): boolean {
  return err instanceof ApiCallError && (err.status === 404 || err.status === 405);
}

export async function listRepos(
  api: ApiClient,
  summary: ProjectSummary,
): Promise<{ repos: RepoInfo[]; fromServer: boolean }> {
  try {
    const json = await api.raw("GET", PROPOSED_REPOS_PATH(summary.project.id));
    const parsed = z.object({ repos: z.array(RepoInfoSchema) }).parse(json);
    return { repos: parsed.repos, fromServer: true };
  } catch (err) {
    if (missingRoute(err)) return { repos: fallbackRepos(summary), fromServer: false };
    throw err;
  }
}

export async function listRefs(
  api: ApiClient,
  projectId: string,
  repo: string,
): Promise<{ refs: RepoRefs; fromServer: boolean }> {
  try {
    const json = await api.raw("GET", `${PROPOSED_REPOS_PATH(projectId)}/refs`, {
      query: { repo },
    });
    return { refs: RepoRefsSchema.parse(json), fromServer: true };
  } catch (err) {
    if (missingRoute(err)) return { refs: EMPTY_REFS, fromServer: false };
    throw err;
  }
}

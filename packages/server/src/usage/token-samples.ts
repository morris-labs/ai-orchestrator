// Token samples from the finished runs of every project on this host.
//
// A project's engine runs in that project's container and sees only its own
// runs. The server reads each project's `token-sample.json` files on the host
// and passes them into a preview, so a project with few runs of its own can
// estimate from the others. A sample holds numbers and settings only. The
// server never mounts one project's files into another project's container.
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  HOST_TOKEN_SAMPLE_LIMIT,
  RUNS_DIR,
  RunTokenSampleSchema,
  TOKEN_SAMPLE_FILE,
  type RunTokenSample,
} from "@aio/contracts";

/** The newest runs of one project to read. */
const RUNS_PER_PROJECT = 30;
/** A larger file is not a sample the engine wrote. */
const MAX_SAMPLE_BYTES = 256 * 1024;

async function readSample(file: string): Promise<RunTokenSample | null> {
  try {
    // A link could point anywhere on the host, so only a regular file counts.
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_SAMPLE_BYTES) return null;
    const parsed = RunTokenSampleSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One project's stored samples, newest first. A missing or damaged file is skipped. */
export async function readProjectTokenSamples(root: string): Promise<RunTokenSample[]> {
  const dir = path.join(root, RUNS_DIR);
  let ids: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  ids.sort().reverse();
  const samples = await Promise.all(
    ids.slice(0, RUNS_PER_PROJECT).map((id) => readSample(path.join(dir, id, TOKEN_SAMPLE_FILE))),
  );
  return samples.filter((s, i): s is RunTokenSample => s !== null && s.runId === ids[i]);
}

/**
 * The samples of every project root but the excluded one, newest first and at
 * most `HOST_TOKEN_SAMPLE_LIMIT` of them. Project names and paths stay out of
 * the result.
 */
export async function readHostTokenSamples(
  roots: readonly string[],
  exclude: string,
): Promise<RunTokenSample[]> {
  const others = [...new Set(roots)].filter((r) => r !== exclude);
  const all = (await Promise.all(others.map(readProjectTokenSamples))).flat();
  return all.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, HOST_TOKEN_SAMPLE_LIMIT);
}

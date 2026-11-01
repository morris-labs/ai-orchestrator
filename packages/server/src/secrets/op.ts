// The 1Password CLI (`op`) behind an interface, so tests use a double.
// Secret values never appear in a log line or an error message.
import type { OpStatus } from "@agentbox/contracts";
import { ApiError } from "../api/errors.js";
import type { ProcessRunner, RunResult } from "../jobs/process.js";

/** A field of an item, without its value. */
export interface OpFieldInfo {
  /** The field's id within the item; unique, unlike the label. */
  id: string;
  label: string;
  section?: string;
  /** The type in 1Password, such as `CONCEALED` or `STRING`. */
  type: string;
}

/** An item and the fields that hold a value, without any value. */
export interface OpItemInfo {
  id: string;
  title: string;
  fields: OpFieldInfo[];
}

export interface OpClient {
  status(): Promise<OpStatus>;
  /** Resolves one `op://VAULT/ITEM/FIELD` reference. */
  read(ref: string): Promise<string>;
  /**
   * Lists the items of a vault with the id, label, section, and type of each
   * field that holds a value. The values are dropped before this returns.
   * Throws `secrets_locked` or `secrets_unavailable` like `read`.
   */
  listItems(vault: string): Promise<OpItemInfo[]>;
}

/** Output from `op` that means the CLI is installed but not signed in. */
const LOCKED_PATTERN = /sign(ed)? ?in|not currently signed|no accounts|authoriz/i;

/** How many `op item get` calls run at once. */
const ITEM_GET_CONCURRENCY = 4;

/** Field types that can't serve as a static secret. */
const SKIPPED_TYPES = new Set(["OTP", "SECTION", "REFERENCE"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Keeps the id, label, section, and type of each field that has a value. It
 * reads a value only to see that one exists, and builds new objects from an
 * allow list, so nothing else from `op`'s output survives.
 */
export function extractFields(itemJson: unknown): OpFieldInfo[] {
  const fields = (itemJson as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  const out: OpFieldInfo[] = [];
  for (const f of fields as unknown[]) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    const type = (str(rec.type) ?? "STRING").toUpperCase();
    if (SKIPPED_TYPES.has(type)) continue;
    if (str(rec.value) === undefined) continue;
    const id = str(rec.id);
    const label = str(rec.label) ?? id;
    if (id === undefined || label === undefined) continue;
    const section = str((rec.section as { label?: unknown } | undefined)?.label);
    out.push({ id, label, type, ...(section ? { section } : {}) });
  }
  return out;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The text could hold a value, so the message names only what failed.
    throw new ApiError("secrets_unavailable", `${what} isn't valid JSON.`);
  }
}

export class OpCli implements OpClient {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async status(): Promise<OpStatus> {
    const version = await this.runner.run("op", ["--version"], {
      env: this.env,
      timeoutMs: 10_000,
    });
    const installed = !version.failedToStart && version.code === 0;
    if (!installed) return { installed: false, version: null, signedIn: false, mode: "none" };
    const whoami = await this.runner.run("op", ["whoami", "--format", "json"], {
      env: this.env,
      timeoutMs: 15_000,
    });
    return {
      installed: true,
      version: version.stdout.trim() || null,
      signedIn: whoami.code === 0,
      mode: this.env.OP_SERVICE_ACCOUNT_TOKEN ? "service_account" : "desktop",
    };
  }

  async read(ref: string): Promise<string> {
    const result = await this.runner.run("op", ["read", "--no-newline", ref], {
      env: this.env,
      timeoutMs: 30_000,
    });
    if (result.code === 0) return result.stdout;
    throw this.failure(result, `resolve ${ref}`, ref);
  }

  async listItems(vault: string): Promise<OpItemInfo[]> {
    const list = await this.runner.run(
      "op",
      ["item", "list", "--vault", vault, "--format", "json"],
      { env: this.env, timeoutMs: 30_000 },
    );
    if (list.code !== 0) throw this.failure(list, `list vault ${vault}`);
    const summaries = parseJson(list.stdout, `The item list of vault ${vault}`);
    if (!Array.isArray(summaries)) return [];
    const heads: { id: string; title: string }[] = [];
    for (const s of summaries as unknown[]) {
      const rec = (s ?? {}) as Record<string, unknown>;
      const id = str(rec.id);
      if (id !== undefined) heads.push({ id, title: str(rec.title) ?? id });
    }
    const items: (OpItemInfo | null)[] = new Array<OpItemInfo | null>(heads.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < heads.length; i = next++) {
        const head = heads[i]!;
        const got = await this.runner.run(
          "op",
          ["item", "get", head.id, "--vault", vault, "--format", "json"],
          { env: this.env, timeoutMs: 30_000 },
        );
        if (got.code !== 0) throw this.failure(got, `read item ${head.title}`);
        // The only use of `got.stdout`: it holds values, so it goes no further.
        const fields = extractFields(parseJson(got.stdout, `Item ${head.title}`));
        if (fields.length > 0) items[i] = { ...head, fields };
      }
    };
    await Promise.all(Array.from({ length: ITEM_GET_CONCURRENCY }, worker));
    return items.filter((x): x is OpItemInfo => x !== null);
  }

  /** The error for a failed `op` run. Only stderr goes in a message: stdout could hold a value. */
  private failure(result: RunResult, what: string, ref?: string): ApiError {
    if (result.failedToStart) {
      return new ApiError(
        "secrets_unavailable",
        "The 1Password CLI (op) is not installed. Install it to resolve secret references.",
      );
    }
    const reason = result.timedOut ? "op timed out" : result.stderr.trim().slice(0, 300);
    if (LOCKED_PATTERN.test(result.stderr)) {
      return new ApiError(
        "secrets_locked",
        ref !== undefined
          ? `The 1Password CLI is not signed in, so ${ref} can't be resolved. Sign in with op signin or unlock the desktop app.`
          : "The 1Password CLI is not signed in. Sign in with op signin or unlock the desktop app.",
      );
    }
    return new ApiError("secrets_unavailable", `Can't ${what}: ${reason}`);
  }
}

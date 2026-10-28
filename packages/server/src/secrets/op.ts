// The 1Password CLI (`op`) behind an interface, so tests use a double.
// Secret values never appear in a log line or an error message.
import type { OpStatus } from "@agentbox/contracts";
import { ApiFailure } from "../api/errors.js";
import type { ProcessRunner } from "../jobs/process.js";

export interface OpClient {
  status(): Promise<OpStatus>;
  /** Resolves one `op://VAULT/ITEM/FIELD` reference. */
  read(ref: string): Promise<string>;
}

/** Output from `op` that means the CLI is installed but not signed in. */
const LOCKED_PATTERN = /sign(ed)? ?in|not currently signed|no accounts|authoriz/i;

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
    if (result.failedToStart) {
      throw new ApiFailure(
        "secrets_unavailable",
        "The 1Password CLI (op) is not installed. Install it to resolve secret references.",
      );
    }
    if (result.code === 0) return result.stdout;
    // Only stderr goes into the message: stdout could hold part of a value.
    const reason = result.timedOut ? "op timed out" : result.stderr.trim().slice(0, 300);
    if (LOCKED_PATTERN.test(result.stderr)) {
      throw new ApiFailure(
        "secrets_locked",
        `The 1Password CLI is not signed in, so ${ref} can't be resolved. Sign in with op signin or unlock the desktop app.`,
      );
    }
    throw new ApiFailure("secrets_unavailable", `Can't resolve ${ref}: ${reason}`);
  }
}

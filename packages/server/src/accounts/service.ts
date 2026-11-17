// Accounts: records in the `accounts` table plus one folder each under
// `DATA_DIR/accounts/VENDOR/NAME`. See `docs/accounts.md`:
// the records, their self-contained folders, instructions, explicit seeding,
// legacy-link migration, and the sign-in check.
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DIR_ENV,
  AccountCreateSchema,
  AccountImportRequestSchema,
  AccountSeedRequestSchema,
  AccountUpdateSchema,
  TranscriptsAdoptRequestSchema,
  type TranscriptsAdoptRequest,
  type TranscriptsAdoptResult,
  accountId,
  parseAccountId,
  type Account,
  type AccountCreate,
  type AccountImportRequest,
  type AccountImportResult,
  type AccountRelinkResult,
  type GlobalSettings,
  type AccountSeedEntry,
  type AccountSeedReport,
  type AccountSeedRequest,
  type AccountSignIn,
  type AccountUpdate,
  type AccountView,
  type Platform,
} from "@aio/contracts";
import type { z } from "zod";
import type { AccountsRepo } from "../db/repositories.js";
import type { DockerClient } from "../docker/types.js";
import {
  accountDirFor,
  bindOf,
  homePaths,
  hostOsOf,
  hostToContainer,
  type HostEnv,
} from "../records/env.js";
import { ApiError } from "../records/errors.js";
import type { SettingsService } from "../records/settings.js";
import type { SqlDatabase } from "../api/core-interface.js";
import { UsageStore } from "../usage/usage-store.js";
import {
  CODEX_STORE_SETTING,
  addCodexFileStore,
  copyTree,
  seedFolder,
  sourceDirOf,
  type SeedSources,
} from "./seed.js";
import { buildAccountInstructions, ensureAccountInstructions } from "./instructions.js";
import { adoptTranscripts } from "./adopt.js";
import { BYPASS_ACCEPTED_KEY, preacceptClaudeAccount } from "./preaccept.js";
import {
  RetentionError,
  ensureRetention,
  protectedRetentionDays,
  retentionWarnings,
} from "./retention.js";
import { copyLinkedConfig, hostConfigLinks } from "./userConfig.js";
import {
  hostProjectsRoot,
  linkProjectsToStore,
  projectsLinkState,
  projectsLinkWarning,
  resolveStore,
  sameLocation,
  type LinkOutcome,
} from "./store.js";

/**
 * Directories whose contents may vanish or that tools treat as scratch space.
 * Codex refuses a `CODEX_HOME` under `/tmp` (phase 0, check 4), so no account
 * folder may live in one.
 */
export const DEFAULT_TEMP_DIRS: readonly string[] = ["/tmp", "/var/tmp", "/dev/shm"];

export interface AccountServiceOptions {
  env: HostEnv;
  repo: AccountsRepo;
  /** The database that holds `svc_usage_samples`, for the label rewrite. */
  db: SqlDatabase;
  settings: SettingsService;
  docker: DockerClient;
  /** The ids of the boxes that run now. Seeding refuses while any does. */
  runningBoxes: () => string[];
  /** The host folders seeding copies. Default: the host user's, from `env.home`. */
  sources?: SeedSources;
  /** Directories that can't hold the accounts folder. Default: `DEFAULT_TEMP_DIRS`. */
  tempDirs?: readonly string[];
}

/** The host folders seeding copies by default. */
export function hostSeedSources(env: HostEnv): SeedSources {
  const p = homePaths(env);
  return {
    claudeDir: p.claudeDir,
    claudeJson: p.claudeJson,
    codexDir: p.codexDir,
    copilotDir: p.copilotDir,
  };
}

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      { issues: r.error.issues },
    );
  }
  return r.data;
}

function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The command that reports a vendor's sign-in, or `null` when the CLI has none. */
export function signInStatusCommand(vendor: Platform): string[] | null {
  if (vendor === "claude") return ["claude", "auth", "status", "--json"];
  if (vendor === "codex") return ["codex", "login", "status"];
  // Copilot reports its sign-in only inside an interactive session.
  return null;
}

/**
 * Reads a sign-in state from a status command's output. Claude prints JSON
 * with `loggedIn` and, when signed in, `email`. Codex prints `Logged in ...`
 * or `Not logged in`. Anything else is `unknown`.
 */
export function parseSignInStatus(
  vendor: Platform,
  result: { exitCode: number | null; stdout: string; stderr: string },
): Pick<AccountSignIn, "state" | "identity"> {
  if (vendor === "claude") {
    try {
      const json = JSON.parse(result.stdout) as { loggedIn?: unknown; email?: unknown };
      if (json.loggedIn === true) {
        return typeof json.email === "string" && json.email !== ""
          ? { state: "signed_in", identity: json.email }
          : { state: "signed_in" };
      }
      if (json.loggedIn === false) return { state: "not_signed_in" };
    } catch {
      // Not JSON: fall through to unknown.
    }
    return { state: "unknown" };
  }
  if (vendor === "codex") {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/not logged in/i.test(text)) return { state: "not_signed_in" };
    if (result.exitCode === 0 && /logged in/i.test(text)) return { state: "signed_in" };
  }
  return { state: "unknown" };
}

export class AccountService {
  private seeding = false;

  constructor(private readonly options: AccountServiceOptions) {}

  private get env(): HostEnv {
    return this.options.env;
  }

  /**
   * Throws `validation` when `dir` lies in a temporary directory, where Codex
   * refuses to run and a reboot can delete a sign-in.
   */
  assertNotTemporary(dir: string): void {
    const resolved = path.resolve(dir);
    for (const t of this.options.tempDirs ?? DEFAULT_TEMP_DIRS) {
      if (resolved === t || resolved.startsWith(`${t}/`)) {
        throw new ApiError(
          "validation",
          `The accounts folder ${dir} is under ${t}, a temporary directory. Codex won't run there. Set the data directory (--data-dir or AIO_DATA_DIR) outside ${t}.`,
          { dir, tempDir: t },
        );
      }
    }
  }

  private legacyLinks(dir: string): string[] {
    const host = homePaths(this.env);
    return hostConfigLinks(dir, [host.claudeDir, host.claudeJson, host.codexDir, host.copilotDir]);
  }

  private relinkNotice(links: readonly string[]): string {
    return `Legacy host configuration links need conversion: ${links.join(", ")}. Run "aio accounts relink" before using this account.`;
  }

  private ensureInstructions(vendor: Platform, dir: string): void {
    ensureAccountInstructions(dir, vendor);
  }

  /** Resolve an account and prepare the same instructions for host and box starts. */
  prepareAccount(vendor: Platform, name?: string): { dir: string; problems: string[] } {
    const id =
      name === undefined
        ? this.options.settings.get().accountDefaults[vendor]
        : accountId(vendor, name);
    if (!id)
      throw new ApiError("not_found", `No default ${vendor} account. Set up an account first.`);
    const account = this.get(id);
    if (account.vendor !== vendor)
      throw new ApiError("validation", `Account ${id} is not a ${vendor} account.`);
    const dir = this.dirOf(vendor, account.name);
    if (!isDirectory(dir))
      throw new ApiError("not_found", `The account folder ${dir} doesn't exist.`);
    const links = this.legacyLinks(dir);
    if (links.length) throw new ApiError("invalid_state", this.relinkNotice(links));
    if (vendor === "claude" && projectsLinkState(dir, this.storeRoot()) !== "ok") {
      throw new ApiError(
        "invalid_state",
        `The account's projects entry does not lead to the shared transcript store. Run "aio accounts relink" before using ${id}.`,
      );
    }
    this.ensureInstructions(vendor, dir);
    return { dir, problems: vendor === "claude" ? [] : buildAccountInstructions(dir, vendor) };
  }

  /** The least `cleanupPeriodDays` an account keeps. See `retention.ts`. */
  private retentionDays(): number {
    return protectedRetentionDays(
      this.env.home,
      this.options.settings.get().transcriptRetentionDays,
    );
  }

  /**
   * Sets `cleanupPeriodDays` in a Claude account folder. Returns a note for
   * the caller's report, or `undefined` when nothing needs saying. A file it
   * can't change isn't fatal here; the first start refuses until it is fixed.
   */
  private keepTranscripts(dir: string): string | undefined {
    try {
      return ensureRetention(dir, this.retentionDays())
        ? `Set cleanupPeriodDays to keep transcripts at least ${this.retentionDays()} days.`
        : undefined;
    } catch (err) {
      if (err instanceof RetentionError) return err.message;
      throw err;
    }
  }

  /** The transcript store that every Claude account links to. */
  storeRoot(): string {
    return this.resolvedStore().root;
  }

  private resolvedStore(settings: GlobalSettings = this.options.settings.get()) {
    return resolveStore(this.env, settings.transcriptStore);
  }

  /**
   * Refuses to switch to accounts mode when a Claude account's projects
   * entry does not lead to the transcript store or host transcripts need adoption.
   * Throws `conflict` and names the fix.
   */
  assertCanUseAccounts(next: GlobalSettings): void {
    const store = this.resolvedStore(next);
    const bad = this.options.repo
      .list()
      .filter((a) => a.vendor === "claude")
      .map((a) => ({
        id: a.id,
        state: projectsLinkState(this.dirOf("claude", a.name), store.root),
      }))
      .filter((a) => a.state !== "ok" && a.state !== "missing");
    if (bad.length > 0) {
      throw new ApiError(
        "conflict",
        `The projects link of ${bad.map((b) => `${b.id} (${b.state})`).join(", ")} doesn't lead to the transcript store ${store.root}. Run "aio accounts relink" first.`,
        { store: store.root, accounts: bad },
      );
    }
    const hostProjects = hostProjectsRoot(this.env);
    if (hostProjects && !sameLocation(hostProjects, store.root)) {
      throw new ApiError(
        "conflict",
        `Host transcripts are outside the transcript store. Run "aio transcripts adopt" first.`,
      );
    }
  }

  /**
   * `accounts.relink`: copies legacy host links into account-owned entries
   * and points Claude accounts' projects at the transcript store. Never
   * deletes a real `projects` folder that holds transcripts; the result says
   * `kept-directory` for it.
   */
  relink(): AccountRelinkResult {
    const store = this.resolvedStore();
    const accounts: AccountRelinkResult["accounts"] = [];
    for (const a of this.options.repo.list()) {
      const dir = this.dirOf(a.vendor, a.name);
      if (!isDirectory(dir)) continue;
      const host = homePaths(this.env);
      const config = copyLinkedConfig(dir, [
        host.claudeDir,
        host.claudeJson,
        host.codexDir,
        host.copilotDir,
      ]);
      this.ensureInstructions(a.vendor, dir);
      const before = a.vendor === "claude" ? projectsLinkState(dir, store.root) : "missing";
      const outcome = a.vendor === "claude" ? linkProjectsToStore(dir, store.root) : "unchanged";
      accounts.push({ id: a.id, before, outcome, config });
    }
    return { store: store.root, source: store.source, accounts };
  }

  /**
   * `transcripts.adopt`: moves the host's `~/.claude/projects` transcripts
   * into the store and points `~/.claude/projects` at it. Refuses while any
   * box runs, because a running box can hold the old folder open, and the
   * record doesn't say which boxes mount the host's `~/.claude`. `dryRun`
   * changes nothing and runs whatever the boxes do.
   */
  adoptTranscripts(input: TranscriptsAdoptRequest): TranscriptsAdoptResult {
    const req = parseOrThrow(TranscriptsAdoptRequestSchema, input);
    if (!req.dryRun) {
      const running = this.options.runningBoxes();
      if (running.length > 0) {
        throw new ApiError(
          "box_running",
          `Stop every box before moving the transcripts. These run: ${running.join(", ")}.`,
          { boxes: running },
        );
      }
    }
    return adoptTranscripts({ home: this.env.home, store: this.storeRoot(), dryRun: req.dryRun });
  }

  /** The note for a link that `linkProjectsToStore` made or changed, else `undefined`. */
  private linkNote(outcome: LinkOutcome, store: string): string | undefined {
    if (outcome === "created") return `Linked projects to the shared transcript store ${store}.`;
    if (outcome === "replaced") {
      return `Replaced the projects link with a link to the shared transcript store ${store}.`;
    }
    if (outcome === "kept-directory") {
      return `projects is a real folder that holds transcripts, so it wasn't replaced. Move its transcripts into ${store}, then run "aio accounts relink".`;
    }
    return undefined;
  }

  /** The account folder of `vendor/name`. */
  dirOf(vendor: Platform, name: string): string {
    return accountDirFor(this.env, vendor, name);
  }

  view(account: Account): AccountView {
    const dir = this.dirOf(account.vendor, account.name);
    const dirExists = isDirectory(dir);
    const links = dirExists ? this.legacyLinks(dir) : [];
    const warnings: string[] = links.length ? [this.relinkNotice(links)] : [];
    if (account.vendor === "claude" && dirExists && !links.length) {
      const store = this.storeRoot();
      const warning = projectsLinkWarning(projectsLinkState(dir, store), dir, store);
      if (warning) warnings.push(warning);
      warnings.push(...retentionWarnings(dir, this.retentionDays()));
      if (
        preacceptClaudeAccount(dir, { trustDirs: [], installMethod: false, dryRun: true })
          .linkedMissing.length > 0
      ) {
        warnings.push(
          `settings.json is the host's file and lacks ${BYPASS_ACCEPTED_KEY}, so a box that enters bypass permissions mode shows Claude's warning once. AI Orchestrator doesn't write the host's file. Add the key there, or replace the link with a file of the account's own.`,
        );
      }
    }
    return {
      account,
      dir,
      dirExists,
      isDefault: this.options.settings.get().accountDefaults[account.vendor] === account.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  list(): AccountView[] {
    return this.options.repo.list().map((a) => this.view(a));
  }

  /** Throws `not_found`. */
  get(id: string): Account {
    const account = parseAccountId(id) ? this.options.repo.get(id) : undefined;
    if (!account) throw new ApiError("not_found", `No account ${id}.`);
    return account;
  }

  /** Whether an account record with this id exists. */
  exists(id: string): boolean {
    return this.options.repo.get(id) !== undefined;
  }

  /**
   * Creates the record and an empty folder (mode 0700). A Codex folder gets a
   * `config.toml` that keeps the sign-in in a file. Refuses an existing record
   * or folder with `conflict`. The first account of a vendor becomes its
   * default.
   */
  create(input: AccountCreate): AccountView {
    const c = parseOrThrow(AccountCreateSchema, input);
    const id = accountId(c.vendor, c.name);
    const dir = this.dirOf(c.vendor, c.name);
    this.assertNotTemporary(dir);
    if (this.exists(id)) throw new ApiError("conflict", `The account ${id} exists.`);
    if (present(dir)) {
      throw new ApiError(
        "conflict",
        `The folder ${dir} exists. Move it away, or pick another name.`,
        { dir },
      );
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.ensureInstructions(c.vendor, dir);
    if (c.vendor === "claude") {
      linkProjectsToStore(dir, this.storeRoot());
      preacceptClaudeAccount(dir);
      this.keepTranscripts(dir);
    }
    if (c.vendor === "codex") {
      fs.writeFileSync(path.join(dir, "config.toml"), `${CODEX_STORE_SETTING}\n`, { mode: 0o600 });
    }
    const now = this.env.now().toISOString();
    const account: Account = {
      id,
      vendor: c.vendor,
      name: c.name,
      label: c.label ?? c.name,
      overflow: c.overflow,
      signIn: { state: "not_signed_in" },
      createdAt: now,
      updatedAt: now,
    };
    if (c.ceiling) account.ceiling = c.ceiling;
    this.options.repo.put(account);
    this.defaultIfNone(c.vendor, id);
    return this.view(account);
  }

  /**
   * `accounts.import`: installs a ready, signed-in config folder as the
   * account `vendor/name`. Moves the folder (a rename, or a copy and delete
   * across file systems), or with `copy` copies it and warns. Never opens a
   * sign-in file: the folder travels as opaque bytes, and the only file read
   * or written afterwards is a Codex `config.toml`. A Claude account gets the
   * `projects` link to the shared store when it has no `projects` entry.
   * The signed-in state is `unknown` until `accounts.check` asks the CLI.
   */
  async importFolder(input: AccountImportRequest): Promise<AccountImportResult> {
    const req = parseOrThrow(AccountImportRequestSchema, input);
    const id = accountId(req.vendor, req.name);
    const dest = this.dirOf(req.vendor, req.name);
    this.assertNotTemporary(dest);
    if (!path.isAbsolute(req.from)) {
      throw new ApiError("validation", `${req.from} isn't an absolute path.`);
    }
    if (!isDirectory(req.from)) {
      throw new ApiError("validation", `${req.from} isn't a folder.`);
    }
    const from = fs.realpathSync(req.from);
    const accountsRoot = path.dirname(path.dirname(dest));
    if (from === accountsRoot || from.startsWith(`${accountsRoot}/`)) {
      throw new ApiError("validation", `${req.from} is already inside the accounts folder.`);
    }
    if (!req.copy && this.isHostVendorFolder(from)) {
      throw new ApiError(
        "validation",
        `${req.from} is the host's own folder, and other accounts link to it. Import it as a copy, or seed an account from it.`,
      );
    }
    if (this.exists(id)) throw new ApiError("conflict", `The account ${id} exists.`);
    if (present(dest)) {
      throw new ApiError(
        "conflict",
        `The folder ${dest} exists. Move it away, or pick another name.`,
        { dest },
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const warnings: string[] = [];
    const mode: "moved" | "copied" = req.copy ? "copied" : "moved";
    const copyInto = async (): Promise<void> => {
      const temp = `${dest}.importing-${process.pid}-${Date.now()}`;
      try {
        await copyTree(from, temp, { denyNames: false });
        fs.renameSync(temp, dest);
      } catch (err) {
        fs.rmSync(temp, { recursive: true, force: true });
        throw err;
      }
    };
    if (req.copy) {
      await copyInto();
      warnings.push(
        req.vendor === "claude"
          ? "A Claude refresh token rotates each time it is used. Only one copy may stay in use: delete the original, or one of the two is signed out."
          : "The original folder still holds the same sign-in. Keep only one copy in use.",
      );
    } else {
      try {
        fs.renameSync(from, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        // Another file system: copy, then delete the original.
        await copyInto();
        fs.rmSync(from, { recursive: true, force: true });
      }
    }
    fs.chmodSync(dest, 0o700);
    const host = homePaths(this.env);
    const converted = copyLinkedConfig(
      dest,
      [host.claudeDir, host.claudeJson, host.codexDir, host.copilotDir],
      accountsRoot,
    );
    if (Object.keys(converted.errors).length) {
      throw new ApiError(
        "validation",
        `Cannot make the imported account self-contained: ${Object.entries(converted.errors)
          .map(([entry, message]) => `${entry}: ${message}`)
          .join("; ")}. Its files are retained at ${dest}; fix the links before importing again.`,
      );
    }
    if (req.vendor === "claude") {
      const store = this.storeRoot();
      const note = this.linkNote(linkProjectsToStore(dest, store), store);
      if (note) warnings.push(note);

      const pre = preacceptClaudeAccount(dest);
      if (pre.changed.length > 0) {
        warnings.push(`Set ${pre.changed.join(", ")} for the first start.`);
      }
      for (const f of pre.skipped)
        warnings.push(`${f} isn't a JSON object, so it was left as it is.`);
      const kept = this.keepTranscripts(dest);
      if (kept) warnings.push(kept);
    }
    if (req.vendor === "codex" && (await addCodexFileStore(path.join(dest, "config.toml")))) {
      warnings.push(`Added ${CODEX_STORE_SETTING} to config.toml.`);
    }
    this.ensureInstructions(req.vendor, dest);
    const now = this.env.now().toISOString();
    const account: Account = {
      id,
      vendor: req.vendor,
      name: req.name,
      label: req.label ?? req.name,
      overflow: false,
      signIn: { state: "unknown" },
      createdAt: now,
      updatedAt: now,
    };
    this.options.repo.put(account);
    this.defaultIfNone(req.vendor, id);
    return { ...this.view(account), mode, warnings };
  }

  /** Changes the label, the ceiling (`null` clears it), or `overflow`. */
  update(id: string, patch: AccountUpdate): AccountView {
    const p = parseOrThrow(AccountUpdateSchema, patch);
    const next: Account = { ...this.get(id), updatedAt: this.env.now().toISOString() };
    if (p.label !== undefined) next.label = p.label;
    if (p.overflow !== undefined) next.overflow = p.overflow;
    if (p.ceiling === null) delete next.ceiling;
    else if (p.ceiling !== undefined) next.ceiling = p.ceiling;
    return this.view(this.options.repo.put(next));
  }

  /** True when `folder` is the host user's own vendor folder, which accounts link to. */
  private isHostVendorFolder(folder: string): boolean {
    const p = homePaths(this.options.env);
    return [p.claudeDir, p.codexDir, p.copilotDir].some((dir) => {
      try {
        return fs.realpathSync(dir) === folder;
      } catch {
        return false;
      }
    });
  }

  /**
   * Deletes the record and keeps the folder, which can hold the user's only
   * copy of settings and history. Refuses a vendor's default account.
   */
  remove(id: string): { keptDir: string } {
    const account = this.get(id);
    if (this.options.settings.get().accountDefaults[account.vendor] === id) {
      throw new ApiError(
        "conflict",
        `${id} is the default ${account.vendor} account. Pick another default first.`,
      );
    }
    this.options.repo.delete(id);
    return { keptDir: this.dirOf(account.vendor, account.name) };
  }

  /**
   * Asks the vendor CLI whether the account is signed in, in a throwaway
   * container from the engine image with the account folder mounted at its
   * container path. Stores and returns the answer. Copilot has no
   * non-interactive status command, so its state stays `unknown`. The CLI's
   * output is parsed for the state and the identity only, and never logged.
   */
  async check(id: string): Promise<AccountView> {
    const account = this.get(id);
    const dir = this.dirOf(account.vendor, account.name);
    if (!isDirectory(dir)) throw new ApiError("conflict", `The folder ${dir} doesn't exist.`);
    if (this.legacyLinks(dir).length) return this.view(account);
    const checkedAt = this.env.now().toISOString();
    const command = signInStatusCommand(account.vendor);
    let signIn: AccountSignIn = { state: "unknown", checkedAt };
    if (command) {
      const image = this.options.settings.get().engineImage;
      if (!(await this.options.docker.inspectImage(image))) {
        throw new ApiError("image_missing", `The image ${image} doesn't exist. Build it first.`);
      }
      const containerDir = hostToContainer(dir, hostOsOf(this.env));
      const result = await this.options.docker.runOnce({
        image,
        entrypoint: [],
        cmd: command,
        binds: [bindOf(dir, containerDir)],
        env: [`${ACCOUNT_DIR_ENV[account.vendor]}=${containerDir}`, "DISABLE_AUTOUPDATER=1"],
        user: this.env.user,
        timeoutMs: 60_000,
      });
      signIn = { ...parseSignInStatus(account.vendor, result), checkedAt };
    }
    const saved = this.options.repo.put({ ...this.get(id), signIn, updatedAt: checkedAt });
    return this.view(saved);
  }

  /** Makes `id` its vendor's default when the vendor has none. Returns whether it did. */
  private defaultIfNone(vendor: Platform, id: string): boolean {
    if (this.options.settings.get().accountDefaults[vendor] !== undefined) return false;
    this.options.settings.setAccountDefault(vendor, id);
    return true;
  }

  /**
   * Checks a seed request before its job starts: no box runs, and no
   * requested account has a record or a folder. Returns the parsed request.
   */
  validateSeed(input: AccountSeedRequest): z.output<typeof AccountSeedRequestSchema> {
    const req = parseOrThrow(AccountSeedRequestSchema, input);
    if (this.seeding) throw new ApiError("conflict", "Seeding is already running.");
    const running = this.options.runningBoxes();
    if (running.length > 0 && !req.dryRun) {
      throw new ApiError(
        "box_running",
        `Stop every box before you seed accounts. Running: ${running.join(", ")}.`,
        { running },
      );
    }
    for (const vendor of new Set(req.vendors)) {
      this.assertNotTemporary(this.dirOf(vendor, req.name));
    }
    const taken = [...new Set(req.vendors)]
      .map((vendor) => ({ id: accountId(vendor, req.name), dir: this.dirOf(vendor, req.name) }))
      .filter((a) => this.exists(a.id) || present(a.dir));
    if (taken.length > 0) {
      throw new ApiError(
        "conflict",
        `These accounts or their folders exist: ${taken.map((t) => t.id).join(", ")}. Seeding never overwrites an account.`,
        { taken },
      );
    }
    return req;
  }

  /**
   * Copies each requested vendor's host folder into a new account, leaving
   * out the sign-in files, records the account as not signed in, makes it
   * the vendor's default when there is none, and relabels the vendor's
   * legacy usage samples with the account id. With `dryRun` it reports what
   * it would do and changes nothing. `log` gets progress lines for the job
   * terminal; it never gets a file's content.
   */
  async seed(
    input: AccountSeedRequest,
    log: (line: string) => void = () => undefined,
  ): Promise<AccountSeedReport> {
    const req = this.validateSeed(input);
    this.seeding = true;
    try {
      const sources = this.options.sources ?? hostSeedSources(this.env);
      const usage = new UsageStore(this.options.db);
      const accounts: AccountSeedEntry[] = [];
      for (const vendor of [...new Set(req.vendors)]) {
        const id = accountId(vendor, req.name);
        const dir = this.dirOf(vendor, req.name);
        const source = sourceDirOf(sources, vendor);
        const base = {
          id,
          vendor,
          source,
          dir,
          files: 0,
          bytes: 0,
          symlinks: 0,
          leftOut: [],
          skippedSpecial: [],
          madeDefault: false,
          usageRelabeled: 0,
        };
        if (!isDirectory(source)) {
          log(`Skipped ${id}: ${source} isn't a folder.\r\n`);
          accounts.push({
            ...base,
            status: "skipped",
            reason: `${source} isn't a folder.`,
          });
          continue;
        }
        log(`${req.dryRun ? "Would copy" : "Copying"} ${source} to ${dir}.\r\n`);
        const copied = await seedFolder(vendor, sources, dir, {
          dryRun: req.dryRun,
          copyHostSetup: req.copyHostSetup,
        });
        copied.notes.push(
          vendor === "copilot"
            ? "The host and account may share a Copilot sign-in; re-authentication or revocation can sign out the other copy. Sign in separately if both remain in use."
            : `The host and account may share ${vendor === "claude" ? "Claude credentials, including an API key" : "Codex credentials"}. Refresh token rotation can sign out the other copy. Sign in separately if both remain in use.`,
        );
        for (const note of copied.notes) log(`  ${note}\r\n`);
        if (vendor === "claude" && !req.dryRun) {
          const store = this.storeRoot();
          const note = this.linkNote(linkProjectsToStore(dir, store), store);
          if (note) log(`  ${note}\r\n`);
          const pre = preacceptClaudeAccount(dir);
          if (pre.changed.length > 0) {
            log(`  Set ${pre.changed.join(", ")} for the first start.\r\n`);
          }
          const kept = this.keepTranscripts(dir);
          if (kept) log(`  ${kept}\r\n`);
        }
        if (!req.dryRun) this.ensureInstructions(vendor, dir);
        if (copied.leftOut.length > 0) {
          log(`  Left out: ${copied.leftOut.join(", ")}.\r\n`);
        }
        const hasDefault = this.options.settings.get().accountDefaults[vendor] !== undefined;
        let madeDefault = false;
        let usageRelabeled = usage.countLegacy(vendor);
        if (!req.dryRun) {
          const now = this.env.now().toISOString();
          this.options.repo.put({
            id,
            vendor,
            name: req.name,
            label: req.name,
            overflow: false,
            signIn: { state: "unknown" },
            seededFrom: source,
            createdAt: now,
            updatedAt: now,
          });
          madeDefault = this.defaultIfNone(vendor, id);
          usageRelabeled = usage.relabelLegacy(vendor, id);
        } else {
          madeDefault = !hasDefault;
        }
        log(
          `${req.dryRun ? "Would seed" : "Seeded"} ${id}: ${copied.files} files, ${copied.symlinks} links, ${usageRelabeled} usage samples relabeled.\r\n`,
        );
        accounts.push({
          ...base,
          status: req.dryRun ? "would_seed" : "seeded",
          reason: null,
          files: copied.files,
          bytes: copied.bytes,
          symlinks: copied.symlinks,
          leftOut: copied.leftOut,
          skippedSpecial: copied.skippedSpecial,
          notes: copied.notes,
          madeDefault,
          usageRelabeled,
        });
      }
      return { dryRun: req.dryRun, accounts };
    } finally {
      this.seeding = false;
    }
  }
}

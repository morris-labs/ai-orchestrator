// Accounts: one config folder per vendor sign-in, so that boxes and review
// runs can use several accounts of one vendor side by side. See
// `docs/v4/design-accounts.md` and `docs/accounts.md`.
//
// An account is a database record plus its folder,
// `DATA_DIR/accounts/VENDOR/NAME/`. The folder holds everything the CLI keeps
// in its home folder. The server derives the folder from the id and never
// stores it as free text.
import { z } from "zod";
import {
  AccountIdSchema,
  AccountNameSchema,
  CountSchema,
  IsoDateTimeSchema,
  PlatformSchema,
  VendorSchema,
  type Platform,
} from "./common.js";
import { CeilingSchema } from "./records.js";

/** The folder, relative to the data directory, that holds every account folder. */
export const ACCOUNTS_DIR = "accounts";

/** The environment variable that points each vendor's CLI at an account folder. */
export const ACCOUNT_DIR_ENV = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  copilot: "COPILOT_HOME",
} as const satisfies Record<Platform, string>;

/**
 * The command that signs an account in, run inside a container with the
 * account's variable set. Copilot must use `--device-code`: plain
 * `copilot login` starts a browser flow whose callback on `127.0.0.1` the host
 * browser can't reach (phase 0, check 5). Codex uses its device flow for the
 * same reason.
 */
export const ACCOUNT_SIGN_IN_COMMAND = {
  claude: ["claude", "auth", "login"],
  codex: ["codex", "login", "--device-auth"],
  copilot: ["copilot", "login", "--device-code"],
} as const satisfies Record<Platform, readonly string[]>;

/** The account name that seeding gives each vendor's first account. */
export const DEFAULT_SEED_ACCOUNT_NAME = "personal";

/**
 * Whether an account is signed in, as the vendor CLI last reported it.
 * `unknown` means the server hasn't asked, or the CLI has no way to tell
 * without an interactive session (Copilot).
 */
export const SignInStateSchema = z.enum(["signed_in", "not_signed_in", "unknown"]);
export type SignInState = z.infer<typeof SignInStateSchema>;

export const AccountSignInSchema = z.object({
  state: SignInStateSchema,
  /** The email or login the CLI reports. Display only. */
  identity: z.string().min(1).optional(),
  /** When the server last asked the CLI. Absent when it never asked. */
  checkedAt: IsoDateTimeSchema.optional(),
});
export type AccountSignIn = z.infer<typeof AccountSignInSchema>;

/**
 * An account record. `ceiling` and `overflow` are stored from phase 1 on;
 * the scheduler applies them from phase 3 of the design.
 */
export const AccountSchema = z.object({
  /** `VENDOR/NAME`. */
  id: AccountIdSchema,
  vendor: VendorSchema,
  name: AccountNameSchema,
  /** A display name, such as "Work (Claude Pro)". */
  label: z.string().min(1),
  /** Replaces the vendor's global ceiling for this account. */
  ceiling: CeilingSchema.optional(),
  /** Whether the scheduler can move another account's calls here. */
  overflow: z.boolean(),
  signIn: AccountSignInSchema,
  /** The host folder that seeding copied, when seeding made the account. */
  seededFrom: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Account = z.infer<typeof AccountSchema>;

/** An account as the API returns it. */
export const AccountViewSchema = z.object({
  account: AccountSchema,
  /** The account folder on the host, `DATA_DIR/accounts/VENDOR/NAME`. */
  dir: z.string().min(1),
  /** Whether the folder exists. */
  dirExists: z.boolean(),
  /** Whether the account is its vendor's default. */
  isDefault: z.boolean(),
  /**
   * Problems with the folder that a person can fix, such as a Claude
   * `projects` link that doesn't lead to the transcript store. Absent or
   * empty when there are none.
   */
  warnings: z.array(z.string()).optional(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

/** The body of `accounts.create`. The first account of a vendor becomes its default. */
export const AccountCreateSchema = z
  .object({
    vendor: VendorSchema,
    name: AccountNameSchema,
    /** Default: the name. */
    label: z.string().min(1).optional(),
    ceiling: CeilingSchema.optional(),
    overflow: z.boolean().default(false),
  })
  .strict();
export type AccountCreate = z.input<typeof AccountCreateSchema>;

/** The body of `accounts.update`. `null` clears the ceiling. */
export const AccountUpdateSchema = z
  .object({
    label: z.string().min(1),
    ceiling: CeilingSchema.nullable(),
    overflow: z.boolean(),
  })
  .partial()
  .strict();
export type AccountUpdate = z.infer<typeof AccountUpdateSchema>;

/** The body of `accounts.seed`. */
export const AccountSeedRequestSchema = z
  .object({
    /** The vendors to seed. Default: every vendor. */
    vendors: z
      .array(VendorSchema)
      .min(1)
      .default([...PlatformSchema.options]),
    /** The name of each seeded account. */
    name: AccountNameSchema.default(DEFAULT_SEED_ACCOUNT_NAME),
    /** Reports what seeding would copy, and copies nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type AccountSeedRequest = z.input<typeof AccountSeedRequestSchema>;

/** What seeding did, or with `dryRun` would do, for one vendor. */
export const AccountSeedEntrySchema = z.object({
  id: AccountIdSchema,
  vendor: VendorSchema,
  /** The host folder it copies. */
  source: z.string().min(1),
  /** The account folder it creates. */
  dir: z.string().min(1),
  /**
   * `seeded`, `would_seed` (a dry run), or `skipped` when the host folder
   * doesn't exist.
   */
  status: z.enum(["seeded", "would_seed", "skipped"]),
  /** Why seeding skipped the vendor, or `null`. */
  reason: z.string().nullable(),
  files: CountSchema,
  bytes: CountSchema,
  /** Symbolic links copied as links, never followed. */
  symlinks: CountSchema,
  /** Sign-in files left out, by path relative to the host folder. Never their contents. */
  leftOut: z.array(z.string()),
  /** Sockets, pipes, and devices, which a copy can't hold, by relative path. */
  skippedSpecial: z.array(z.string()),
  /** Whether seeding made this account its vendor's default. */
  madeDefault: z.boolean(),
  /** Usage samples relabeled from the legacy label to this account's id. */
  usageRelabeled: CountSchema,
});
export type AccountSeedEntry = z.infer<typeof AccountSeedEntrySchema>;

/** The result of `accounts.seed`, carried as the `account_seed` job's result. */
export const AccountSeedReportSchema = z.object({
  dryRun: z.boolean(),
  accounts: z.array(AccountSeedEntrySchema),
});
export type AccountSeedReport = z.infer<typeof AccountSeedReportSchema>;

/** The result of `accounts.remove`. The server never deletes an account folder. */
export const AccountRemoveResultSchema = z.object({
  /** The account folder, which stays on disk. */
  keptDir: z.string().min(1),
});

/**
 * The body of `accounts.import`: installs a ready, signed-in folder as an
 * account. `from` is the vendor's config folder itself (a `CLAUDE_CONFIG_DIR`,
 * a `CODEX_HOME`, or a `COPILOT_HOME`). The server moves the folder, or with
 * `copy` copies it. It never reads the sign-in files.
 */
export const AccountImportRequestSchema = z
  .object({
    vendor: VendorSchema,
    name: AccountNameSchema,
    /** An absolute host path. */
    from: z.string().min(1),
    /** Default: the name. */
    label: z.string().min(1).optional(),
    /** Copies the folder and leaves the original. Default: move. */
    copy: z.boolean().default(false),
  })
  .strict();
export type AccountImportRequest = z.input<typeof AccountImportRequestSchema>;

/** The result of `accounts.import`: the new account plus what to tell the person. */
export const AccountImportResultSchema = AccountViewSchema.extend({
  mode: z.enum(["moved", "copied"]),
  /** Notes for a person to read, such as the refresh-token warning for a copy. */
  warnings: z.array(z.string()),
});
export type AccountImportResult = z.infer<typeof AccountImportResultSchema>;

/** What `accounts.relink` did to one Claude account. */
export const AccountRelinkEntrySchema = z.object({
  id: AccountIdSchema,
  /** The `projects` entry before: `ok`, `missing`, `dangling`, `foreign`, or `directory`. */
  before: z.enum(["ok", "missing", "dangling", "foreign", "directory"]),
  /** `unchanged`, `created`, `replaced`, or `kept-directory` (a real folder with transcripts). */
  outcome: z.enum(["unchanged", "created", "replaced", "kept-directory"]),
});
export type AccountRelinkEntry = z.infer<typeof AccountRelinkEntrySchema>;

/** The result of `accounts.relink`. */
export const AccountRelinkResultSchema = z.object({
  /** The transcript store every Claude account links to. */
  store: z.string().min(1),
  /** Where the store came from: `setting` (the override) or `data` (`DATA_DIR/transcripts/claude`). */
  source: z.enum(["setting", "data"]),
  accounts: z.array(AccountRelinkEntrySchema),
});
export type AccountRelinkResult = z.infer<typeof AccountRelinkResultSchema>;

/** The body of `transcripts.adopt`. */
export const TranscriptsAdoptRequestSchema = z
  .object({
    /** Reports what would happen and changes nothing. Default: false. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type TranscriptsAdoptRequest = z.input<typeof TranscriptsAdoptRequestSchema>;

/** The result of `transcripts.adopt`. */
export const TranscriptsAdoptResultSchema = z.object({
  /** The transcript store, `DATA_DIR/transcripts/claude` unless overridden. */
  store: z.string().min(1),
  dryRun: z.boolean(),
  /** `adopted`, `unchanged`, or `blocked` (clashes, or a layout the command leaves alone). */
  status: z.enum(["adopted", "unchanged", "blocked"]),
  /** The real folder that held the host's transcripts, when there was one to move. */
  source: z.string().min(1).optional(),
  /** Files moved, or with `dryRun` that would be moved, into the store. */
  moved: z.number().int().nonnegative(),
  /** Files already in the store with the same content. */
  duplicates: z.number().int().nonnegative(),
  /** Paths that exist in both places with different content. Nothing is moved while any exist. */
  clashes: z.array(z.string()),
  /** What was done, or with `dryRun` what would be done. */
  actions: z.array(z.string()),
});
export type TranscriptsAdoptResult = z.infer<typeof TranscriptsAdoptResultSchema>;

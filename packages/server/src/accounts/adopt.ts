// `transcripts.adopt`: moves the host's Claude transcripts into the store
// (`DATA_DIR/transcripts/claude`) and points `~/.claude/projects` at it, so
// that `~/.ai-orchestrator` is the only folder in the home directory that AI Orchestrator
// uses for its own data.
//
// The move merges without overwriting. A file that exists on both sides with
// the same bytes is a duplicate and counts as moved. A file that exists on
// both sides with different bytes is a clash. With any clash the command
// changes nothing, because a partial move would hide the moved transcripts
// from the box that still reads the old folder, and it lists the clashes.
import fs from "node:fs";
import path from "node:path";
import { sameLocation } from "./store.js";

export interface AdoptInput {
  /** The host's home directory. */
  home: string;
  /** The store: `DATA_DIR/transcripts/claude`, or the override. */
  store: string;
  dryRun: boolean;
}

export interface AdoptReport {
  store: string;
  dryRun: boolean;
  /**
   * `adopted`: the transcripts are in the store and `~/.claude/projects` leads
   * to it. `unchanged`: nothing to do. `blocked`: clashes, or a layout that
   * the command won't touch; `actions` and `clashes` say why. With `dryRun`,
   * the status is what a real run would report.
   */
  status: "adopted" | "unchanged" | "blocked";
  /** The real folder that held the transcripts, if any. */
  source?: string;
  /** Files moved (or that would be moved) into the store. */
  moved: number;
  /** Files that were already in the store with the same bytes. */
  duplicates: number;
  /** Files that exist in both places with different bytes, relative to the folder. */
  clashes: string[];
  /** What was done, or with `dryRun` what would be done. */
  actions: string[];
}

interface FileMove {
  from: string;
  to: string;
}

interface Plan {
  moves: FileMove[];
  duplicates: FileMove[];
  clashes: string[];
  dirs: string[];
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sameBytes(a: string, b: string): boolean {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function walkPlan(source: string, store: string, rel: string, plan: Plan): void {
  const from = path.join(source, rel);
  for (const name of fs.readdirSync(from)) {
    const r = path.join(rel, name);
    const src = path.join(source, r);
    const dst = path.join(store, r);
    const st = fs.lstatSync(src);
    const target = lstatOrUndefined(dst);
    if (st.isDirectory()) {
      if (target === undefined) plan.dirs.push(r);
      else if (!target.isDirectory()) {
        plan.clashes.push(r);
        continue;
      }
      walkPlan(source, store, r, plan);
    } else if (target === undefined) {
      plan.moves.push({ from: src, to: dst });
    } else if (st.isFile() && target.isFile() && sameBytes(src, dst)) {
      plan.duplicates.push({ from: src, to: dst });
    } else {
      plan.clashes.push(r);
    }
  }
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.utimesSync(to, st.atime, st.mtime);
    }
    fs.unlinkSync(from);
  }
}

function removeEmptyDirs(root: string, rel: string): void {
  const dir = path.join(root, rel);
  for (const name of fs.readdirSync(dir)) {
    const st = fs.lstatSync(path.join(dir, name));
    if (st.isDirectory()) removeEmptyDirs(root, path.join(rel, name));
  }
  if (rel !== "" && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** The links on the way from `start` to a real path, `start` first. */
function linkChain(start: string): string[] {
  const links: string[] = [];
  let current = start;
  for (let hops = 0; hops < 40; hops += 1) {
    const st = lstatOrUndefined(current);
    if (st === undefined || !st.isSymbolicLink()) break;
    links.push(current);
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  return links;
}

/** Moves the host's transcripts into the store and repoints `~/.claude/projects`. */
export function adoptTranscripts(input: AdoptInput): AdoptReport {
  const { home, store, dryRun } = input;
  const projects = path.join(home, ".claude", "projects");
  const report: AdoptReport = {
    store,
    dryRun,
    status: "unchanged",
    moved: 0,
    duplicates: 0,
    clashes: [],
    actions: [],
  };
  const say = (text: string): void => {
    report.actions.push(dryRun ? `Would ${text}` : `Did ${text}`);
  };
  const block = (text: string): AdoptReport => {
    report.status = "blocked";
    report.actions.push(text);
    return report;
  };

  const st = lstatOrUndefined(projects);
  const chain = linkChain(projects);
  let realSource: string | undefined;
  try {
    realSource = fs.realpathSync(projects);
  } catch {
    realSource = undefined;
  }
  if (realSource !== undefined && !fs.statSync(realSource).isDirectory()) {
    return block(`${projects} leads to ${realSource}, which isn't a folder. Nothing changed.`);
  }

  const storeStat = lstatOrUndefined(store);
  if (storeStat !== undefined && !fs.statSync(store, { throwIfNoEntry: false })?.isDirectory()) {
    return block(`The store ${store} exists but isn't a folder. Nothing changed.`);
  }
  const realStore = storeStat === undefined ? path.resolve(store) : fs.realpathSync(store);

  const alreadyThere = realSource !== undefined && realSource === realStore;
  if (realSource !== undefined && !alreadyThere) {
    if (isInside(realStore, realSource) || isInside(realSource, realStore)) {
      return block(
        `${realSource} and the store ${realStore} are nested in each other. Nothing changed.`,
      );
    }
    report.source = realSource;
  }

  // Phase 1: plan the merge.
  const plan: Plan = { moves: [], duplicates: [], clashes: [], dirs: [] };
  if (report.source !== undefined) walkPlan(report.source, realStore, "", plan);
  report.moved = plan.moves.length;
  report.duplicates = plan.duplicates.length;
  report.clashes = plan.clashes;
  if (plan.clashes.length > 0) {
    return block(
      `${plan.clashes.length} file(s) exist in both ${report.source} and the store with different content. Nothing changed. Resolve them by hand, then run the command again.`,
    );
  }

  const directLink =
    st?.isSymbolicLink() === true &&
    chain.length === 1 &&
    path.resolve(path.dirname(projects), fs.readlinkSync(projects)) === path.resolve(store);
  const needsMove = report.source !== undefined;
  const needsLink = !directLink;
  // An intermediate link goes only when it points at the store itself.
  const redundant = chain
    .slice(1)
    .filter(
      (l) =>
        lstatOrUndefined(l)?.isSymbolicLink() === true &&
        sameLocation(path.resolve(path.dirname(l), fs.readlinkSync(l)), realStore),
    );
  if (!needsMove && !needsLink && redundant.length === 0) {
    report.actions.push(`${projects} already leads to the store ${store}. Nothing to do.`);
    return report;
  }

  // Phase 2: act.
  if (storeStat === undefined) {
    say(`create the store ${store}`);
    if (!dryRun) fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  }
  if (needsMove) {
    say(
      `move ${plan.moves.length} file(s) from ${report.source} into the store (${plan.duplicates.length} already there with the same content)`,
    );
    if (!dryRun && report.source !== undefined) {
      for (const d of plan.dirs) fs.mkdirSync(path.join(realStore, d), { recursive: true });
      for (const m of plan.moves) moveFile(m.from, m.to);
      // Duplicates are the same bytes in the store; the source copy goes.
      for (const m of plan.duplicates) fs.unlinkSync(m.from);
      removeEmptyDirs(report.source, "");
    }
  }
  if (needsLink) {
    if (st?.isSymbolicLink()) {
      say(`repoint the link ${projects} at the store ${store}`);
      if (!dryRun) {
        fs.unlinkSync(projects);
        fs.symlinkSync(store, projects);
      }
    } else if (st?.isDirectory()) {
      say(`replace the folder ${projects} with a link to the store ${store}`);
      if (!dryRun) {
        if (fs.readdirSync(projects).length > 0) {
          return block(`${projects} isn't empty after the move. Left it in place.`);
        }
        fs.rmdirSync(projects);
        fs.symlinkSync(store, projects);
      }
    } else if (st === undefined || realSource === undefined) {
      say(`link ${projects} to the store ${store}`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(projects), { recursive: true });
        fs.symlinkSync(store, projects);
      }
    }
  }
  for (const l of redundant) {
    say(`remove the link ${l}, which points at the store`);
    if (!dryRun) fs.unlinkSync(l);
  }
  if (!dryRun && report.source !== undefined) {
    const left = lstatOrUndefined(report.source);
    if (left?.isDirectory() === true && fs.readdirSync(report.source).length === 0) {
      report.actions.push(`The folder ${report.source} is empty. Remove it by hand when you like.`);
    }
  }
  report.status = "adopted";
  return report;
}

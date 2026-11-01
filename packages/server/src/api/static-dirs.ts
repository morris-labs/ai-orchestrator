// Where the server finds the web bundles of the two apps.
import { existsSync } from "node:fs";
import path from "node:path";

/** The apps whose renderer bundles the server serves. */
export type WebApp = "boxes" | "review";

/** Where the installed package puts the apps' web bundles, one directory per app. */
export const INSTALLED_WEB_ROOT = "/usr/share/ai-orchestrator/web";

/**
 * The web bundle of `app` when no environment variable names one:
 * `apps/APP/dist/renderer` in the source checkout at `repoRoot` when it has
 * an `index.html`, else the installed package's copy. The installed
 * Electron app can't serve here, because its bundle sits inside `app.asar`.
 */
export function defaultStaticDir(
  repoRoot: string,
  app: WebApp,
  exists: (p: string) => boolean = existsSync,
): string {
  const checkout = path.join(repoRoot, "apps", app, "dist", "renderer");
  if (exists(path.join(checkout, "index.html"))) return checkout;
  const installed = path.join(INSTALLED_WEB_ROOT, app);
  if (exists(path.join(installed, "index.html"))) return installed;
  return checkout;
}

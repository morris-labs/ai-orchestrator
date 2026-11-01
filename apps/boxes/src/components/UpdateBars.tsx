// The bars above the table: a new app release, a Claude Code newer than the
// image's, an engine that doesn't match, and Docker being unreachable.
import type { ImageStatus, Updates } from "@aio/contracts";
import { Button } from "@aio/ui";

export interface UpdateBarsProps {
  updates: Updates | null;
  image: ImageStatus | null;
  dismissedVersion: string | null;
  dockerUnavailable: boolean;
  serverError: string | null;
  onViewRelease: (url: string) => void;
  onDismissRelease: (version: string) => void;
  onRebuildImage: () => void;
  onOpenSetup: () => void;
  onRetry: () => void;
}

export function UpdateBars(p: UpdateBarsProps) {
  const app = p.updates?.app;
  const cc = p.updates?.claudeCode;
  return (
    <div className="bx-bars">
      {p.serverError && (
        <div className="ab-update-bar" role="alert">
          <span className="ab-update-text">{p.serverError}</span>
          <Button onClick={p.onRetry}>Retry</Button>
        </div>
      )}
      {p.dockerUnavailable && (
        <div className="ab-update-bar" role="alert">
          <span className="ab-update-text">
            Docker is not reachable. Start the Docker daemon, then refresh.
          </span>
          <Button onClick={p.onOpenSetup}>Setup...</Button>
          <Button onClick={p.onRetry}>Refresh</Button>
        </div>
      )}
      {app?.updateAvailable && app.latest && app.latest !== p.dismissedVersion && (
        <div className="ab-update-bar" role="status">
          <span className="ab-update-text">
            AI Orchestrator {app.latest} is available (you have {app.current}).
          </span>
          {app.releaseUrl && (
            <Button onClick={() => p.onViewRelease(app.releaseUrl as string)}>View release</Button>
          )}
          <Button onClick={() => p.onDismissRelease(app.latest as string)}>Dismiss</Button>
        </div>
      )}
      {cc?.stale && (
        <div className="ab-update-bar" role="status">
          <span className="ab-update-text">
            Claude Code {cc.latest} is available; the image has {cc.image ?? "none"}.
          </span>
          <Button onClick={p.onRebuildImage}>Rebuild image</Button>
        </div>
      )}
      {p.image && p.image.exists && !p.image.engineMatches && (
        <div className="ab-update-bar" role="status">
          <span className="ab-update-text">
            The image carries engine {p.image.engineVersion ?? "unknown"}, but this server needs{" "}
            {p.image.expectedEngineVersion}. Rebuild the image before you start boxes.
          </span>
          <Button onClick={p.onRebuildImage}>Rebuild image</Button>
        </div>
      )}
      {p.image && !p.image.exists && (
        <div className="ab-update-bar" role="status">
          <span className="ab-update-text">
            The {p.image.name} image doesn't exist yet. Build it before you create a box.
          </span>
          <Button onClick={p.onOpenSetup}>Setup...</Button>
        </div>
      )}
    </div>
  );
}

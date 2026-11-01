// Chooses how the secrets broker reaches a new container. A Unix socket in a
// bind-mounted directory works only when the Docker engine shares the host's
// kernel. Docker Desktop runs the engine in a virtual machine, on macOS,
// Windows and Linux alike, and a host socket can't cross that boundary, so
// the broker listens on the host's loopback address instead and checks a
// bearer token. See `docs/secrets.md`.
import type { BrokerTransport, BrokerTransportSetting } from "@aio/contracts";
import type { DockerEngineInfo } from "../docker/types.js";

/** Why the transport was chosen, for the log. */
export interface BrokerTransportDecision {
  transport: BrokerTransport;
  /**
   * True when the container needs `host.docker.internal:host-gateway` in its
   * hosts file: TCP with a native engine, which doesn't define the name.
   * Docker Desktop defines it.
   */
  hostGateway: boolean;
  /** The engine is Docker Desktop. */
  dockerDesktop: boolean;
  reason: string;
}

/**
 * Whether the engine is Docker Desktop: its `/info` names the operating
 * system `Docker Desktop` (macOS, Windows, and Linux alike), the engine is
 * named `docker-desktop`, or a label names the Desktop backend.
 */
export function isDockerDesktopInfo(info: DockerEngineInfo): boolean {
  if (/docker desktop/i.test(info.operatingSystem)) return true;
  if (info.name === "docker-desktop") return true;
  return info.labels.some((l) => l.startsWith("com.docker.desktop."));
}

/**
 * Whether `DOCKER_HOST` points at a Docker Desktop endpoint: the
 * `~/.docker/desktop/docker.sock` socket of macOS and Linux, or the
 * `dockerDesktopLinuxEngine` and `docker_engine` named pipes of Windows.
 */
export function isDockerDesktopHost(dockerHost: string | undefined): boolean {
  if (!dockerHost) return false;
  return (
    /[/\\]\.docker[/\\]desktop[/\\]/.test(dockerHost) ||
    /dockerDesktop\w*Engine/i.test(dockerHost) ||
    /[/\\]pipe[/\\]docker_engine$/i.test(dockerHost)
  );
}

export interface DecideTransportInput {
  setting: BrokerTransportSetting | undefined;
  /** `process.platform` of the server. */
  platform: NodeJS.Platform;
  /** The engine's `/info`, or `null` when it couldn't be read. */
  info: DockerEngineInfo | null;
  /** The server's `DOCKER_HOST`. */
  dockerHost?: string;
}

/**
 * Resolves the transport setting. `auto` picks TCP for Docker Desktop and
 * for a server on macOS or Windows, whose engine always runs in a virtual
 * machine, and the Unix socket otherwise, including when `/info` can't be
 * read on Linux.
 */
export function decideBrokerTransport(input: DecideTransportInput): BrokerTransportDecision {
  const dockerDesktop =
    (input.info !== null && isDockerDesktopInfo(input.info)) ||
    isDockerDesktopHost(input.dockerHost);
  const nativeLinux = input.platform === "linux" && !dockerDesktop;
  const tcp = (reason: string): BrokerTransportDecision => ({
    transport: "tcp",
    hostGateway: nativeLinux,
    dockerDesktop,
    reason,
  });
  const unix = (reason: string): BrokerTransportDecision => ({
    transport: "unix",
    hostGateway: false,
    dockerDesktop,
    reason,
  });
  const setting = input.setting ?? "auto";
  if (setting === "tcp") return tcp("the brokerTransport setting is tcp");
  if (setting === "unix") return unix("the brokerTransport setting is unix");
  if (dockerDesktop) return tcp("the Docker engine is Docker Desktop");
  if (input.platform === "darwin" || input.platform === "win32") {
    return tcp(`the server runs on ${input.platform}, where Docker runs in a virtual machine`);
  }
  return unix("the Docker engine shares the host's kernel");
}

export interface BrokerTransportResolverOptions {
  /** Reads the engine's `/info`; absent or failing means unknown. */
  info?: () => Promise<DockerEngineInfo>;
  setting: () => BrokerTransportSetting | undefined;
  platform?: NodeJS.Platform;
  dockerHost?: string;
  log?: (message: string) => void;
}

/**
 * Resolves the transport for each container launch. Reads `/info` once and
 * keeps it, since an engine doesn't turn into Docker Desktop while the
 * server runs; a failed read is tried again at the next launch.
 */
export class BrokerTransportResolver {
  private info: DockerEngineInfo | null = null;
  private lastReason = "";

  constructor(private readonly opts: BrokerTransportResolverOptions) {}

  async resolve(): Promise<BrokerTransportDecision> {
    if (this.info === null && this.opts.info) {
      try {
        this.info = await this.opts.info();
      } catch {
        this.info = null;
      }
    }
    const decision = decideBrokerTransport({
      setting: this.opts.setting(),
      platform: this.opts.platform ?? process.platform,
      info: this.info,
      dockerHost: this.opts.dockerHost,
    });
    if (decision.reason !== this.lastReason) {
      this.lastReason = decision.reason;
      // The default on native Linux stays quiet, as before this module.
      if (decision.transport === "tcp" || decision.dockerDesktop) {
        this.opts.log?.(
          `Secrets broker: using the ${decision.transport} transport because ${decision.reason}.`,
        );
      }
      if (decision.transport === "tcp" && decision.hostGateway) {
        this.opts.log?.(
          "Secrets broker: the tcp transport listens on 127.0.0.1 only, which a container on " +
            "a native Linux engine can't reach through host-gateway. Use it with Docker Desktop.",
        );
      }
    }
    return decision;
  }
}

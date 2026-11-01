// The address a hub's link listener binds by default: this machine's
// primary LAN IPv4 address. The hub listens on the LAN only, so it never
// binds every interface, a Docker bridge, or Tailscale.
import fs from "node:fs";
import os from "node:os";

/** One address of a network interface, as `os.networkInterfaces()` gives it. */
export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type InterfaceTable = Record<string, InterfaceAddress[] | undefined>;

/** Interface names that are never the LAN: Docker bridges and Tailscale. */
const IGNORED_INTERFACE = /^(docker|br-|veth|tailscale)/;

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

/** True for an address in an RFC 1918 private range. */
export function isPrivateIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  const [a, b] = o as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True for an address in the carrier-grade NAT range, 100.64.0.0/10, that Tailscale uses. */
export function isCgnatIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  return o !== undefined && o[0] === 100 && o[1]! >= 64 && o[1]! <= 127;
}

function isIpv4(entry: InterfaceAddress): boolean {
  return entry.family === "IPv4" || entry.family === 4;
}

/** The LAN candidates of each interface, in the table's order. */
export function lanCandidates(interfaces: InterfaceTable): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (IGNORED_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || !isIpv4(entry)) continue;
      if (isCgnatIpv4(entry.address) || !isPrivateIpv4(entry.address)) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

/**
 * Chooses the primary LAN IPv4 address: the private (RFC 1918) address of
 * the interface that holds the default route. Loopback, Docker bridges,
 * and Tailscale never count. When the default route goes through an
 * interface with no LAN address, such as a VPN, or no default route is
 * known, the only LAN address on the machine wins. Returns `undefined`
 * when there is none, or more than one and none of them on the default
 * route.
 */
export function primaryLanAddress(
  interfaces: InterfaceTable,
  defaultRouteInterface: string | undefined,
): string | undefined {
  const candidates = lanCandidates(interfaces);
  if (defaultRouteInterface !== undefined) {
    const onRoute = candidates.find((c) => c.name === defaultRouteInterface);
    if (onRoute) return onRoute.address;
  }
  return candidates.length === 1 ? candidates[0]!.address : undefined;
}

/**
 * The interface that holds the IPv4 default route, from the text of
 * `/proc/net/route`: the first line whose destination and mask are zero.
 */
export function parseDefaultRoute(table: string): string | undefined {
  for (const line of table.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [iface, destination, , , , , , mask] = cols;
    if (destination === "00000000" && mask === "00000000") return iface;
  }
  return undefined;
}

/** Reads the default route's interface on Linux, or `undefined` elsewhere. */
export function readDefaultRouteInterface(file = "/proc/net/route"): string | undefined {
  try {
    return parseDefaultRoute(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** This machine's primary LAN IPv4 address, or `undefined` when it has none. */
export function detectLanAddress(): string | undefined {
  return primaryLanAddress(os.networkInterfaces(), readDefaultRouteInterface());
}

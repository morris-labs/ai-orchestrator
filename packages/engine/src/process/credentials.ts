// Gets the credentials a child needs from the secrets broker, which replaces
// the container environment as their source (docs/v4/design-secrets-broker.md).
// The engine asks only for the names a profile takes (`wantsCredential()`)
// and that the project lists, and hands the values to that one child.
//
// Without a broker, as for an engine started by hand, children get nothing
// from here. A broker that fails costs a warning, not the child: a vendor
// CLI signed in with OAuth doesn't need a key, and one that does reports its
// own sign-in error.
import { wantsCredential, type EnvProfile } from "./env.js";

/** What the engine asks for credentials; `BrokerClient` in production. */
export interface CredentialSource {
  names(): Promise<string[]>;
  read(names: readonly string[], caller?: string): Promise<Record<string, string>>;
}

let source: CredentialSource | null = null;
let warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined;
let lastWarning: string | null = null;

/**
 * Sets the broker the engine asks, or `null` for none, and where its
 * warnings go. The engine calls this once at startup.
 */
export function setCredentialSource(
  next: CredentialSource | null,
  onWarning?: (message: string, fields?: Record<string, unknown>) => void,
): void {
  source = next;
  warn = onWarning ?? (() => undefined);
  lastWarning = null;
}

/**
 * The credentials the profile's child takes, from the broker. Never rejects:
 * returns `{}` without a broker, for the `untrusted` profile, and when the
 * broker fails, which it reports once until a call succeeds again.
 */
export async function credentialsFor(
  profile: EnvProfile,
  caller: string,
): Promise<Record<string, string>> {
  if (!source || profile === "untrusted") return {};
  try {
    const names = (await source.names()).filter((n) => wantsCredential(n, profile));
    const values = names.length > 0 ? await source.read(names, `engine ${profile}: ${caller}`) : {};
    lastWarning = null;
    return values;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== lastWarning) {
      lastWarning = message;
      warn("The secrets broker didn't give a child its credentials; it starts without them", {
        profile,
        reason: message,
      });
    }
    return {};
  }
}

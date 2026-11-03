// How a GUI app enrolls with a hub: the code key, the proofs, and the messages
// of the exchange on the hub's GUI listener. Node.js only, like `tls.ts`: import
// it as `@aio/contracts/gui-enroll`, never from page code.
//
// The exchange mirrors node enrollment, with its own key derivation and proof
// labels, so a code or a proof for one can't serve the other. The app connects
// without checking the hub's certificate, and proves that it knows the code with
// an HMAC over the certificate it saw. A program in the middle presents another
// certificate, so the hub refuses the proof. The hub proves that it knows the
// code too, so the app pins a certificate only from the hub that issued the code.
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { MachineNameSchema } from "./records.js";

/** The prefix of a GUI client certificate's common name; the client ID follows. */
export const GUI_CERT_PREFIX = "aio-gui:";
/** The enrollment path on the hub's GUI listener. It's the one path that needs no certificate. */
export const GUI_ENROLL_PATH = "/gui/v1/enroll";

/** The code as typed, with case, spaces, and hyphens removed and look-alike letters mapped. */
export function normalizeEnrollmentCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

/** The key derived from a GUI enrollment code, which is all the hub stores of it. */
export function guiCodeKey(code: string): string {
  return createHash("sha256")
    .update(`aio-gui-enroll-v1:${normalizeEnrollmentCode(code)}`)
    .digest("hex");
}

/** The app's proof that it knows the code and saw `hubFingerprint`. */
export function guiClientProof(
  key: string,
  parts: { hubFingerprint: string; nonce: string; name: string; publicKey: string },
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(["gui", parts.hubFingerprint, parts.nonce, parts.name, parts.publicKey]))
    .digest("hex");
}

/** The hub's proof that it knows the code, over what it returns. */
export function guiHubProof(
  key: string,
  parts: { nonce: string; clientId: string; clientCert: string; caCert: string; hubCert: string },
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(
      JSON.stringify([
        "gui-hub",
        parts.nonce,
        parts.clientId,
        parts.clientCert,
        parts.caCert,
        parts.hubCert,
      ]),
    )
    .digest("hex");
}

export const GuiEnrollRequestSchema = z.object({
  name: MachineNameSchema,
  publicKey: z.string().min(1).max(4096),
  nonce: z.string().regex(/^[0-9a-f]{32,128}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GuiEnrollRequest = z.infer<typeof GuiEnrollRequestSchema>;

export const GuiEnrollResponseSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  clientCert: z.string(),
  caCert: z.string(),
  hubCert: z.string(),
  proof: z.string(),
});
export type GuiEnrollResponse = z.infer<typeof GuiEnrollResponseSchema>;

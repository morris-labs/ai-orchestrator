import { AccountSeedReportSchema, DEFAULT_SEED_ACCOUNT_NAME, type Job } from "@aio/contracts";
import { useEffect, useState } from "react";
import { useApiClient } from "../api/react";
import { errorMessage } from "../api/errors";
import { Button } from "./Dialog";

/** The one-time seed choices shared by Setup and Review settings. */
export function AccountSeedControl({ hostMode = false }: { hostMode?: boolean }) {
  const client = useApiClient();
  const [name, setName] = useState(DEFAULT_SEED_ACCOUNT_NAME);
  const [copyHostSetup, setCopyHostSetup] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (job?.status !== "running") return;
    let live = true;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void client
        .call("jobs.get", { params: { jobId: job.id } })
        .then((next) => {
          if (live) {
            setJob(next);
            setError(null);
          }
        })
        .catch((err) => {
          if (live) setError(errorMessage(err));
        })
        .finally(() => {
          polling = false;
        });
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, job?.id, job?.status]);
  const seed = async () => {
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      setJob(await client.call("accounts.seed", { body: { name, copyHostSetup } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };
  const busy = starting || job?.status === "running";
  const report = AccountSeedReportSchema.safeParse(job?.result);
  return (
    <section aria-label="Seed accounts">
      <h3>Seed accounts</h3>
      {hostMode && (
        <p className="ab-hint">
          Host mode is retired and boxes cannot start. Set up accounts, run aio accounts relink,
          then aio accounts mode accounts.
        </p>
      )}
      <p>
        Copy available host sign-ins into new Claude, Codex and Copilot accounts once. Existing
        accounts stay unchanged.
      </p>
      <label>
        Account name{" "}
        <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="ab-checkbox">
        <input
          type="checkbox"
          checked={copyHostSetup}
          disabled={busy}
          onChange={(e) => setCopyHostSetup(e.target.checked)}
        />
        Copy host Claude instructions, settings, skills and plugins once
      </label>
      <Button disabled={busy || !name.trim()} onClick={() => void seed()}>
        Seed accounts
      </Button>
      {busy && <p role="status">Seeding accounts…</p>}
      {error && <p role="alert">{error}</p>}
      {job?.status === "failed" && <p role="alert">{job.error?.message ?? "Seeding failed."}</p>}
      {job?.status === "finished" && report.success && (
        <ul role="status">
          {report.data.accounts.map((a) => (
            <li key={a.id}>
              {a.id}: {a.status}
              {a.reason ? ` — ${a.reason}` : ""}
              {a.notes?.map((note, i) => (
                <p key={i}>{note}</p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

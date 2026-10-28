// The Usage tab: CPU and memory totals, one card per running container with
// its boxes, and each vendor account against its ceiling.
import type { BoxView } from "@agentbox/contracts";
import { ProgressBar, useApiClient } from "@agentbox/ui";
import { useEffect, useState } from "react";
import { formatBytes } from "../logic/format";
import { displayName } from "../logic/status";

interface VendorRow {
  vendor: string;
  account: string;
  utilization: number;
  label: string;
  over: boolean;
  resetAt: string | null;
}

export function UsageView({
  boxes,
  disk,
}: {
  boxes: BoxView[];
  disk: ReadonlyMap<string, number>;
}) {
  const client = useApiClient();
  const [vendors, setVendors] = useState<VendorRow[] | null>(null);
  useEffect(() => {
    let live = true;
    client
      .call("usage.get", {})
      .then((r) => {
        if (!live) return;
        setVendors(
          r.vendors.map((v) => {
            const sample = v.latest.find((s) => s.window === v.window) ?? v.latest[0];
            const utilization = sample?.utilization ?? 0;
            const label =
              sample?.spendUsd != null
                ? `$${sample.spendUsd.toFixed(2)}`
                : `${Math.round(utilization * 100)}%`;
            return {
              vendor: v.vendor,
              account: v.account,
              utilization,
              label,
              over: v.overCeiling,
              resetAt: v.resetAt,
            };
          }),
        );
      })
      .catch(() => live && setVendors([]));
    return () => {
      live = false;
    };
  }, [client]);

  const running = boxes.filter((b) => b.status === "running");
  const containers = new Map<string, BoxView[]>();
  for (const b of running) containers.set(b.container, [...(containers.get(b.container) ?? []), b]);
  let cpu = 0;
  let mem = 0;
  let limit = 0;
  for (const [, list] of containers) {
    const s = list[0]?.stats;
    if (!s) continue;
    cpu += s.cpuPercent;
    mem += s.memBytes;
    limit = Math.max(limit, s.memLimitBytes);
  }
  return (
    <div className="bx-usage">
      <section className="ab-group">
        <h3>Totals</h3>
        <div className="bx-usage-row">
          <span>CPU</span>
          <ProgressBar
            fraction={cpu / 100 / Math.max(1, containers.size)}
            label={`${cpu.toFixed(1)}%`}
          />
        </div>
        <div className="bx-usage-row">
          <span>Memory</span>
          <ProgressBar fraction={limit > 0 ? mem / limit : 0} label={formatBytes(mem)} />
        </div>
        <div className="bx-dim">
          {running.length} running {running.length === 1 ? "box" : "boxes"} in {containers.size}{" "}
          {containers.size === 1 ? "container" : "containers"}
        </div>
      </section>
      <div className="bx-cards">
        {[...containers].map(([name, list]) => {
          const s = list[0]?.stats;
          return (
            <section key={name} className="ab-group bx-card" aria-label={name}>
              <h3>{name}</h3>
              <div className="bx-dim">{list.map(displayName).join(", ")}</div>
              <div className="bx-usage-row">
                <span>CPU</span>
                {s ? (
                  <ProgressBar
                    fraction={s.cpuPercent / 100}
                    label={`${s.cpuPercent.toFixed(1)}%`}
                  />
                ) : (
                  <span>-</span>
                )}
              </div>
              <div className="bx-usage-row">
                <span>Memory</span>
                {s ? (
                  <ProgressBar
                    fraction={s.memLimitBytes > 0 ? s.memBytes / s.memLimitBytes : 0}
                    label={`${formatBytes(s.memBytes)} / ${formatBytes(s.memLimitBytes)}`}
                  />
                ) : (
                  <span>-</span>
                )}
              </div>
              <div className="bx-dim">
                Disk {disk.has(name) ? formatBytes(disk.get(name) as number) : "-"}
              </div>
            </section>
          );
        })}
      </div>
      <section className="ab-group">
        <h3>Model usage</h3>
        {vendors === null ? (
          <div className="bx-dim">Loading...</div>
        ) : vendors.length === 0 ? (
          <div className="bx-dim">No usage samples yet.</div>
        ) : (
          vendors.map((v) => (
            <div key={`${v.vendor}:${v.account}`} className="bx-usage-row">
              <span>
                {v.vendor} <span className="bx-dim">{v.account}</span>
              </span>
              <ProgressBar
                fraction={v.utilization}
                label={`${v.label}${v.over ? " (over ceiling)" : ""}`}
              />
              <span className="bx-dim">
                {v.resetAt ? `resets ${new Date(v.resetAt).toLocaleString()}` : ""}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

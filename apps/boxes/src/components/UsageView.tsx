// The Usage tab: CPU and memory totals, one card per running container with
// its boxes, and each vendor account's usage windows.
import type { BoxView } from "@aio/contracts";
import { ProgressBar, useApiClient } from "@aio/ui";
import { useEffect, useState } from "react";
import { formatBytes } from "../logic/format";
import { displayName } from "../logic/status";
import { vendorRows, type VendorUsageInput } from "../logic/usage";

/** How often the panel reads usage again and rechecks reset times. */
const USAGE_REFRESH_MS = 60_000;

export function UsageView({
  boxes,
  disk,
}: {
  boxes: BoxView[];
  disk: ReadonlyMap<string, number>;
}) {
  const client = useApiClient();
  const [vendors, setVendors] = useState<VendorUsageInput[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let live = true;
    const load = () => {
      client
        .call("usage.get", {})
        .then((r) => {
          if (!live) return;
          setVendors(r.vendors);
          setNow(new Date());
        })
        .catch(() => {
          if (!live) return;
          setVendors((previous) => previous ?? []);
          setNow(new Date());
        });
    };
    load();
    const timer = setInterval(load, USAGE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
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
          vendorRows(vendors, now).map((v) => (
            <div key={`${v.vendor}:${v.account}`} className="bx-usage-vendor">
              <div>
                {v.vendor} <span className="bx-dim">{v.account}</span>
              </div>
              {v.windows.length === 0 ? (
                <div className="bx-dim">No usage windows reported.</div>
              ) : (
                v.windows.map((w) => (
                  <div key={w.window} className="bx-usage-row">
                    <span>{w.name}</span>
                    {w.current ? (
                      <ProgressBar fraction={w.current.fraction} label={w.current.label} />
                    ) : (
                      <span className="bx-dim">No recent data</span>
                    )}
                    <span className="bx-dim">{w.detail}</span>
                  </div>
                ))
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

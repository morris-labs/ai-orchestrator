// The Usage tab: CPU and memory totals, one card per running container with
// its boxes, and each vendor account's usage windows.
import type { BoxView, Vendor } from "@aio/contracts";
import { ProgressBar, useApiClient } from "@aio/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const load = useCallback(() => {
    client
      .call("usage.get", {})
      .then((r) => {
        if (!live.current) return;
        setVendors(r.vendors);
        setFailed(false);
        // The server's clock decides resets, so the panel agrees with `overCeiling`.
        setNow(r.time ? new Date(r.time) : new Date());
      })
      .catch(() => {
        if (!live.current) return;
        setVendors((previous) => previous ?? []);
        setFailed(true);
        setNow(new Date());
      });
  }, [client]);
  useEffect(() => {
    live.current = true;
    load();
    // A hidden panel makes no requests, and catches up when it shows again.
    const tick = () => {
      if (!document.hidden) load();
    };
    const timer = setInterval(tick, USAGE_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);
  const clearBlock = (vendor: string, account: string) => {
    client
      .call("usage.clear", { body: { vendor: vendor as Vendor, account } })
      .then(load)
      .catch(() => setFailed(true));
  };

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
        {failed ? (
          <div className="bx-dim" role="alert">
            Couldn&apos;t refresh usage. These readings can be out of date.
          </div>
        ) : null}
        {vendors === null ? (
          <div className="bx-dim">Loading...</div>
        ) : vendors.length === 0 ? (
          <div className="bx-dim">No usage samples yet.</div>
        ) : (
          vendorRows(vendors, now).map((v) => (
            <div key={`${v.vendor}:${v.account}`} className="bx-usage-vendor">
              <div>
                {v.vendor} <span className="bx-dim">{v.account}</span>
                {v.overWithoutRow ? <span> (over ceiling)</span> : null}
                {v.over ? (
                  <button
                    type="button"
                    title="Use this after you buy a reset. The next real sample replaces this."
                    onClick={() => clearBlock(v.vendor, v.account)}
                  >
                    Clear block
                  </button>
                ) : null}
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

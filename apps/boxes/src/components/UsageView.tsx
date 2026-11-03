// The Usage tab: CPU and memory totals, one card per running container with
// its boxes, and each vendor account's usage windows.
import type { BoxView, Vendor } from "@aio/contracts";
import { ProgressBar, errorMessage, useApiClient, useMessageBox } from "@aio/ui";
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
  const { confirm } = useMessageBox();
  const [vendors, setVendors] = useState<VendorUsageInput[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [failed, setFailed] = useState(false);
  // The outcome of the last Clear block; a refresh doesn't erase it.
  const [clearNote, setClearNote] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const live = useRef(true);
  const requests = useRef(0);
  const load = useCallback(() => {
    // An older response must not overwrite a newer one, such as the reload after Clear block.
    const request = ++requests.current;
    client
      .call("usage.get", {})
      .then((r) => {
        if (!live.current || request !== requests.current) return;
        setVendors(r.vendors);
        setFailed(false);
        // The server's clock decides resets, so the panel agrees with `overCeiling`.
        setNow(r.time ? new Date(r.time) : new Date());
      })
      .catch(() => {
        if (!live.current || request !== requests.current) return;
        setVendors((previous) => previous ?? []);
        setFailed(true);
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
  const clearBlock = async (vendor: string, account: string) => {
    if (clearing) return;
    const ok = await confirm(
      "Clear Block",
      `Clear the block on ${account}?`,
      "Use this only after you buy a reset. The server then treats the account as under its ceiling, and boxes can use it again until the next real sample replaces this one.",
      true,
    );
    if (!ok || !live.current) return;
    setClearing(true);
    setClearNote(null);
    try {
      const r = await client.call("usage.clear", { body: { vendor: vendor as Vendor, account } });
      if (!live.current) return;
      const still = r.vendors.find(
        (v) => v.vendor === vendor && v.account === account,
      )?.overCeiling;
      if (r.cleared === 0) {
        setClearNote(`The server cleared nothing for ${account}. The block stays.`);
      } else if (still) {
        setClearNote(`The block on ${account} cleared, but the account is still over its ceiling.`);
      }
    } catch (err) {
      if (live.current)
        setClearNote(`Couldn't clear the block on ${account}: ${errorMessage(err)}`);
    } finally {
      if (live.current) setClearing(false);
    }
    load();
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
        {clearNote ? (
          <div className="bx-dim" role="status">
            {clearNote}
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
                    className="ab-button"
                    disabled={clearing}
                    title="Use this after you buy a reset. The next real sample replaces this."
                    onClick={() => void clearBlock(v.vendor, v.account)}
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

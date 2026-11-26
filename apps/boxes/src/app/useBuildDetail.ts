// One build's messages, tasks, and usage, loaded through REST and kept
// current with `message.sent`, `build.task.changed`, `lease.settled`, and
// `build.seat.usage` events. A settled call of the build, or a new report of
// the Project manager's transcript usage, reloads its usage, since the
// server sums usage over settlements and reports.
import type { BuildTaskView, BuildUsage, EventOf, Message } from "@aio/contracts";
import { useApiClient, useEvent, useResync } from "@aio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addMessages, applyTaskChanged } from "../logic/buildView";

export interface BuildDetail {
  /** Oldest first. */
  messages: readonly Message[];
  tasks: readonly BuildTaskView[];
  /** `null` until the first load. */
  usage: BuildUsage | null;
  loaded: boolean;
  /** Why the last load failed, or `null`. */
  error: string | null;
}

export interface BuildDetailData extends BuildDetail {
  /**
   * Adds messages the view learned of from an answer, such as the owner's
   * post, before their `message.sent` events arrive.
   */
  addMessages: (messages: readonly Message[]) => void;
}

const EMPTY: BuildDetail = { messages: [], tasks: [], usage: null, loaded: false, error: null };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useBuildDetail(buildId: string): BuildDetailData {
  const client = useApiClient();
  const [detail, setDetail] = useState<BuildDetail>(EMPTY);
  /** The build the view shows; a response for another build is dropped. */
  const current = useRef(buildId);
  /** Events that arrived while a load was in flight, applied again on top of its snapshot. */
  const pending = useRef<{
    messages: Message[];
    tasks: EventOf<"build.task.changed">[];
  } | null>(null);
  const usageLoad = useRef<{ again: boolean } | null>(null);

  const reload = useCallback(async () => {
    pending.current = { messages: [], tasks: [] };
    try {
      const [m, t, u] = await Promise.all([
        client.call("builds.messages", { params: { buildId } }),
        client.call("builds.tasks", { params: { buildId } }),
        client.call("builds.usage", { params: { buildId } }),
      ]);
      if (current.current !== buildId) return;
      const later = pending.current ?? { messages: [], tasks: [] };
      setDetail({
        messages: addMessages(m.messages, later.messages),
        tasks: later.tasks.reduce(applyTaskChanged, t.tasks),
        usage: u,
        loaded: true,
        error: null,
      });
    } catch (err) {
      if (current.current !== buildId) return;
      setDetail((d) => ({ ...d, loaded: true, error: messageOf(err) }));
    } finally {
      pending.current = null;
    }
  }, [client, buildId]);

  const reloadUsage = useCallback(async () => {
    if (usageLoad.current) {
      usageLoad.current.again = true;
      return;
    }
    const state = { again: true };
    usageLoad.current = state;
    try {
      while (state.again) {
        state.again = false;
        const usage = await client.call("builds.usage", { params: { buildId } });
        if (current.current === buildId) setDetail((d) => ({ ...d, usage }));
      }
    } catch (err) {
      if (current.current === buildId) setDetail((d) => ({ ...d, error: messageOf(err) }));
    } finally {
      usageLoad.current = null;
    }
  }, [client, buildId]);

  useEffect(() => {
    current.current = buildId;
    setDetail(EMPTY);
    void reload();
  }, [buildId, reload]);

  useResync(() => void reload());

  useEvent("message.sent", (ev) => {
    if (ev.message.buildId !== buildId) return;
    pending.current?.messages.push(ev.message);
    setDetail((d) => ({ ...d, messages: addMessages(d.messages, [ev.message]) }));
  });

  useEvent("build.task.changed", (ev) => {
    if (ev.buildId !== buildId) return;
    pending.current?.tasks.push(ev);
    setDetail((d) => ({ ...d, tasks: applyTaskChanged(d.tasks, ev) }));
  });

  useEvent("lease.settled", (ev) => {
    if (ev.buildId === buildId) void reloadUsage();
  });

  useEvent("build.seat.usage", (ev) => {
    if (ev.buildId === buildId) void reloadUsage();
  });

  const add = useCallback(
    (messages: readonly Message[]) => {
      const own = messages.filter((m) => m.buildId === buildId);
      pending.current?.messages.push(...own);
      setDetail((d) => ({ ...d, messages: addMessages(d.messages, own) }));
    },
    [buildId],
  );

  return useMemo(() => ({ ...detail, addMessages: add }), [detail, add]);
}

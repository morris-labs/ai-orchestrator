// The build view: a build's team chat as a conversation with filters by
// task, milestone, seat, and slice; the direct messages to the owner; the
// milestone board; the usage by seat and by specialty; and the owner's
// build controls (pause, resume, cancel, and delete). The conversation
// renders a window of the newest matching messages, so a build with
// thousands of messages stays responsive.
import type { BuildSummary, BuildTaskView, BuildUsage, Message, UsageTotals } from "@aio/contracts";
import { Button, errorMessage, useApiClient, useMessageBox } from "@aio/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBuildDetail } from "../app/useBuildDetail";
import {
  MESSAGE_WINDOW,
  NO_FILTER,
  boardOf,
  directMessages,
  filterMessages,
  filterOptions,
  partyLabel,
  taskStatusLabel,
  type BoardColumn,
  type MessageFilter,
} from "../logic/buildView";

export interface BuildViewProps {
  build: BuildSummary;
}

export function BuildView({ build }: BuildViewProps) {
  const detail = useBuildDetail(build.id);
  return (
    <div className="bx-build-view">
      <BuildControls build={build} />
      {detail.error ? (
        <div className="bx-dim" role="alert">
          Can't load the build: {detail.error}
        </div>
      ) : null}
      <div className="bx-build-columns">
        <Conversation messages={detail.messages} tasks={detail.tasks} />
        <div className="bx-build-side">
          <DirectMessages messages={detail.messages} />
          <Board columns={boardOf(detail.tasks)} />
          <Usage usage={detail.usage} />
        </div>
      </div>
    </div>
  );
}

type BuildAction = "pause" | "resume" | "cancel" | "delete";

/**
 * The owner's build requests. A cancel stops every agent and keeps the
 * branch and the worktree, so the build can resume; a delete removes them
 * and keeps the build's record. Both ask first.
 */
function BuildControls({ build }: { build: BuildSummary }) {
  const client = useApiClient();
  const { confirm } = useMessageBox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const { status } = build;
  const canPause = status === "running";
  const canResume = status === "paused" || status === "cancelled";
  const canCancel = status === "running" || status === "paused" || status === "waiting_escalation";
  const canDelete = status === "finished" || status === "failed" || status === "cancelled";

  const send = async (action: BuildAction) => {
    if (busy) return;
    if (action === "cancel") {
      const ok = await confirm(
        "Cancel Build",
        `Cancel the build ${build.slug}?`,
        "The engine stops every agent and keeps the branch and the worktree. The Scribe writes a closing record, and you can resume the build until you delete it.",
        true,
      );
      if (!ok) return;
    }
    if (action === "delete") {
      const ok = await confirm(
        "Delete Build",
        `Delete the build ${build.slug}?`,
        "The engine removes the build's branch and worktree. The build's record stays, but the build can't resume.",
        true,
      );
      if (!ok) return;
    }
    if (!live.current) return;
    setBusy(true);
    setError(null);
    try {
      const params = { params: { buildId: build.id } };
      if (action === "pause") await client.call("builds.pause", params);
      if (action === "resume") await client.call("builds.resume", params);
      if (action === "cancel") await client.call("builds.cancel", params);
      if (action === "delete") await client.call("builds.delete", params);
    } catch (err) {
      if (live.current) setError(`Couldn't ${action} the build: ${errorMessage(err)}`);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="bx-build-controls" role="group" aria-label="Build controls">
      {canPause ? (
        <Button disabled={busy} onClick={() => void send("pause")}>
          Pause
        </Button>
      ) : null}
      {canResume ? (
        <Button disabled={busy} onClick={() => void send("resume")}>
          Resume
        </Button>
      ) : null}
      {canCancel ? (
        <Button disabled={busy} onClick={() => void send("cancel")}>
          Cancel build
        </Button>
      ) : null}
      {canDelete ? (
        <Button disabled={busy} onClick={() => void send("delete")}>
          Delete build
        </Button>
      ) : null}
      {error ? (
        <span className="bx-dim" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function Conversation(props: { messages: readonly Message[]; tasks: readonly BuildTaskView[] }) {
  const { messages, tasks } = props;
  const [filter, setFilter] = useState<MessageFilter>(NO_FILTER);
  const [limit, setLimit] = useState(MESSAGE_WINDOW);
  const options = useMemo(() => filterOptions(messages, tasks), [messages, tasks]);
  const matching = useMemo(
    () => filterMessages(messages, filter, tasks),
    [messages, filter, tasks],
  );
  const shown = matching.slice(Math.max(0, matching.length - limit));
  const set = (key: keyof MessageFilter) => (value: string) => {
    setFilter((f) => ({ ...f, [key]: value === "" ? null : value }));
    setLimit(MESSAGE_WINDOW);
  };
  return (
    <section className="bx-build-conversation" aria-label="Conversation">
      <div className="bx-build-filters">
        <FilterSelect
          label="Task"
          all="All tasks"
          values={options.tasks}
          onChange={set("taskId")}
        />
        <FilterSelect
          label="Milestone"
          all="All milestones"
          values={options.milestones}
          onChange={set("milestone")}
        />
        <FilterSelect label="Seat" all="All seats" values={options.seats} onChange={set("seat")} />
        <FilterSelect
          label="Slice"
          all="Everyone"
          values={options.slices}
          onChange={set("slice")}
        />
      </div>
      {shown.length < matching.length ? (
        <div className="bx-build-earlier">
          <span className="bx-dim">
            Showing {shown.length} of {matching.length} messages.
          </span>{" "}
          <button type="button" onClick={() => setLimit((n) => n + MESSAGE_WINDOW)}>
            Show earlier messages
          </button>
        </div>
      ) : null}
      <ol className="bx-messages" aria-label="Messages">
        {shown.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </ol>
      {shown.length === 0 ? (
        <div className="bx-dim">
          {messages.length === 0 ? "No messages yet." : "No messages match the filters."}
        </div>
      ) : null}
    </section>
  );
}

function FilterSelect(props: {
  label: string;
  all: string;
  values: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="bx-build-filter">
      {props.label}{" "}
      <select aria-label={props.label} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.all}</option>
        {props.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

function MessageItem({ message: m }: { message: Message }) {
  const about = [m.taskId, m.milestone].filter((x) => x !== null).join(", ");
  return (
    <li className="bx-message" title={`${m.id} ${m.createdAt}`}>
      <div className="bx-message-head">
        <strong>{partyLabel(m.from)}</strong> to <strong>{partyLabel(m.to)}</strong>
        <span className="bx-dim">
          {" "}
          {m.type.replace(/_/g, " ")}
          {about ? ` about ${about}` : ""}
        </span>
      </div>
      <div className="bx-message-body">{m.body}</div>
    </li>
  );
}

function DirectMessages({ messages }: { messages: readonly Message[] }) {
  const direct = useMemo(() => directMessages(messages), [messages]);
  return (
    <section className="bx-build-panel">
      <h3>Direct messages</h3>
      <ol className="bx-messages" aria-label="Direct messages">
        {direct.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </ol>
      {direct.length === 0 ? <div className="bx-dim">No direct messages.</div> : null}
    </section>
  );
}

function Board({ columns }: { columns: readonly BoardColumn[] }) {
  return (
    <section className="bx-build-panel" aria-label="Milestone board">
      <h3>Milestone board</h3>
      {columns.length === 0 ? <div className="bx-dim">No tasks yet.</div> : null}
      <div className="bx-board">
        {columns.map((c) => (
          <div className="bx-board-column" key={c.milestone}>
            <h4>{c.milestone}</h4>
            <ul aria-label={c.milestone}>
              {c.tasks.map((t) => (
                <li key={t.taskId} className={`bx-task bx-task-${t.status}`}>
                  <span>{t.taskId}</span>
                  <span className="bx-dim">{taskStatusLabel[t.status]}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const integer = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function UsageTable(props: {
  label: string;
  heading: string;
  rows: readonly (UsageTotals & { name: string })[];
}) {
  return (
    <table className="bx-usage-table" aria-label={props.label}>
      <thead>
        <tr>
          <th scope="col">{props.heading}</th>
          <th scope="col">Calls</th>
          <th scope="col">Tokens in</th>
          <th scope="col">Tokens out</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="bx-dim">
              No settled calls yet.
            </td>
          </tr>
        ) : (
          props.rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>{integer.format(r.calls)}</td>
              <td>{integer.format(r.tokensIn)}</td>
              <td>{integer.format(r.tokensOut)}</td>
              <td>{dollars.format(r.costEstimate)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function Usage({ usage }: { usage: BuildUsage | null }) {
  const seats = (usage?.bySeat ?? []).map((r) => ({ ...r, name: r.seat ?? "No seat" }));
  const specialties = (usage?.bySpecialty ?? []).map((r) => ({
    ...r,
    name: r.specialty ?? "No specialty",
  }));
  return (
    <section className="bx-build-panel" aria-label="Usage">
      <h3>Usage</h3>
      {usage && usage.total.calls > 0 ? (
        <div className="bx-dim">
          {integer.format(usage.total.calls)} calls, {dollars.format(usage.total.costEstimate)}{" "}
          estimated in total.
        </div>
      ) : null}
      <UsageTable label="Usage by seat" heading="Seat" rows={seats} />
      <UsageTable label="Usage by specialty" heading="Specialty" rows={specialties} />
    </section>
  );
}

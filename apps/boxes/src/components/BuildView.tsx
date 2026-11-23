// The build view: a build's team chat as a conversation with filters by
// task, milestone, seat, and slice; the owner's post box; the open
// escalations, which the owner can resolve; the direct messages to the owner; the milestone board; the
// usage by seat and by specialty; and the owner's build controls (pause,
// resume, cancel, and delete). The conversation renders a window of the
// newest matching messages, so a build with thousands of messages stays
// responsive.
import {
  MESSAGE_BODY_MAX,
  type BuildSummary,
  type BuildTaskView,
  type BuildUsage,
  type DecisionOption,
  type Message,
  type PmItem,
  type UsageTotals,
} from "@aio/contracts";
import { Button, errorMessage, useApiClient, useMessageBox } from "@aio/ui";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useBuildDetail } from "../app/useBuildDetail";
import { isBuildActive } from "../logic/builds";
import {
  OWNER_ACTIONS,
  ownerResolution,
  type OwnerAction,
  type ResolveForm,
} from "../logic/escalations";
import {
  MESSAGE_WINDOW,
  NO_FILTER,
  boardOf,
  directMessages,
  filterMessages,
  filterOptions,
  ownerPostFor,
  partyLabel,
  postTargets,
  taskStatusLabel,
  type BoardColumn,
  type MessageFilter,
  type PostAbout,
} from "../logic/buildView";

export interface BuildViewProps {
  build: BuildSummary;
  /** The build's open escalations, oldest first. */
  escalations?: readonly PmItem[];
}

export function BuildView({ build, escalations = [] }: BuildViewProps) {
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
        <Conversation
          build={build}
          messages={detail.messages}
          tasks={detail.tasks}
          onPosted={detail.addMessages}
        />
        <div className="bx-build-side">
          {escalations.length > 0 ? <Escalations build={build} items={escalations} /> : null}
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
  const deleted = build.deletedAt !== undefined;
  const canPause = status === "running";
  const canResume = !deleted && (status === "paused" || status === "cancelled");
  const canCancel = status === "running" || status === "paused" || status === "waiting_escalation";
  const canDelete =
    !deleted && (status === "finished" || status === "failed" || status === "cancelled");

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
      {deleted ? (
        <span className="bx-dim">The owner deleted this build's branch and worktree.</span>
      ) : null}
      {error ? (
        <span className="bx-dim" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function Conversation(props: {
  build: BuildSummary;
  messages: readonly Message[];
  tasks: readonly BuildTaskView[];
  onPosted: (messages: readonly Message[]) => void;
}) {
  const { build, messages, tasks, onPosted } = props;
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
      {isBuildActive(build) ? (
        <PostBox
          buildId={build.id}
          planning={build.status === "planning"}
          messages={messages}
          tasks={tasks}
          onPosted={onPosted}
        />
      ) : null}
    </section>
  );
}

/**
 * The owner's post box. A post goes to one agent, which runs on it; the
 * engine records it as a decision on the post's task. A post for a seat of
 * a planning meeting under way goes into the meeting instead.
 */
function PostBox(props: {
  buildId: string;
  /** True while the build plans, so a post can go into the meeting under way. */
  planning: boolean;
  messages: readonly Message[];
  tasks: readonly BuildTaskView[];
  onPosted: (messages: readonly Message[]) => void;
}) {
  const { buildId, planning, messages, tasks, onPosted } = props;
  const client = useApiClient();
  const targets = useMemo(() => postTargets(messages, tasks), [messages, tasks]);
  const options = useMemo(() => filterOptions(messages, tasks), [messages, tasks]);
  const [to, setTo] = useState("");
  const [about, setAbout] = useState<PostAbout>("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const target = targets.find((t) => t.label === to) ?? null;
  const text = body.trim();
  const post = target && text ? ownerPostFor(target, about, text, planning) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!post || !target || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const answer = await client.call("builds.post", { params: { buildId }, body: post });
      if (!live.current) return;
      if (answer.route === "agent") {
        onPosted([answer.message]);
        setStatus(`Posted to ${target.label}.`);
      } else {
        setStatus(
          `Posted to the planning meeting ${answer.meeting.id}. Every member reads it at its next turn.`,
        );
      }
      setBody("");
    } catch (err) {
      if (live.current) setError(`Couldn't post: ${errorMessage(err)}`);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <form className="bx-post-box" aria-label="Post to an agent" onSubmit={(e) => void submit(e)}>
      <div className="bx-build-filters">
        <label className="bx-build-filter">
          To{" "}
          <select aria-label="To" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose an agent</option>
            {targets.map((t) => (
              <option key={t.label} value={t.label}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="bx-build-filter">
          About{" "}
          <select aria-label="About" value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="">The agent's task</option>
            {options.tasks.map((id) => (
              <option key={`task:${id}`} value={`task:${id}`}>
                Task {id}
              </option>
            ))}
            {options.milestones.map((name) => (
              <option key={`milestone:${name}`} value={`milestone:${name}`}>
                Milestone {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        aria-label="Post"
        rows={3}
        maxLength={MESSAGE_BODY_MAX}
        value={body}
        placeholder="Write to the agent. The engine records the post as a decision on its task."
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="bx-post-actions">
        <Button type="submit" disabled={busy || post === null}>
          Post
        </Button>
        {target && text && post === null ? (
          <span className="bx-dim">Choose the task or milestone the post is about.</span>
        ) : null}
        {status ? (
          <span className="bx-dim" role="status">
            {status}
          </span>
        ) : null}
        {error ? (
          <span className="bx-dim" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </form>
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

/**
 * The build's open escalations: each one whose pointer didn't reach the
 * Project manager's session, or that waits for an answer. The owner can
 * resolve each one here, like the Project manager does with `aio-build
 * resolve`.
 */
function Escalations({ build, items }: { build: BuildSummary; items: readonly PmItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="bx-build-panel bx-build-escalations" aria-label="Escalations">
      <h3>Open escalations</h3>
      <ol className="bx-messages" aria-label="Open escalations">
        {items.map((item) => (
          <li key={item.id} className="bx-message" title={`${item.id} ${item.createdAt}`}>
            <div className="bx-message-head">
              <strong>{item.ref}</strong>
              <span className="bx-dim">
                {" "}
                {item.deliveredAt === null
                  ? "hasn't reached the Project manager's session"
                  : "waits for an answer"}
              </span>
            </div>
            <div className="bx-message-body">{item.summary}</div>
            <div className="bx-dim">
              <code>{item.file}</code>
            </div>
            {open === item.ref ? (
              <ResolveEscalation
                buildId={build.id}
                escalation={item.ref}
                onClose={() => setOpen(null)}
              />
            ) : (
              <Button onClick={() => setOpen(item.ref)}>{`Resolve ${item.ref}`}</Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const ACTION_LABELS: Record<OwnerAction, string> = {
  retry: "Retry the paused work",
  reorder: "Reorder the tasks, then retry",
  clarify: "Clarify, then retry",
  decide: "Answer the review run's decision",
};

const DECISION_LABELS: Record<DecisionOption, string> = {
  resume: "Resume the review run",
  resume_waive: "Resume and waive findings",
  cancel: "Cancel the review run",
};

/** The owner's resolve form for one escalation. */
function ResolveEscalation(props: { buildId: string; escalation: string; onClose: () => void }) {
  const { buildId, escalation, onClose } = props;
  const client = useApiClient();
  const [form, setForm] = useState<ResolveForm>({
    action: "retry",
    note: "",
    order: "",
    decision: "resume",
    waive: "",
    push: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const request = ownerResolution(escalation, form);
  const set = (patch: Partial<ResolveForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.call("builds.resolve", { params: { buildId }, body: request });
      if (live.current) onClose();
    } catch (err) {
      if (live.current) setError(`Couldn't resolve ${escalation}: ${errorMessage(err)}`);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <form
      className="bx-post-box"
      aria-label={`Resolve ${escalation}`}
      onSubmit={(e) => void submit(e)}
    >
      <div className="bx-build-filters">
        <label className="bx-build-filter">
          Action{" "}
          <select
            aria-label="Action"
            value={form.action}
            onChange={(e) => set({ action: e.target.value as OwnerAction })}
          >
            {OWNER_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        {form.action === "reorder" ? (
          <label className="bx-build-filter">
            Task order{" "}
            <input
              aria-label="Task order"
              value={form.order}
              placeholder="T2, T1"
              onChange={(e) => set({ order: e.target.value })}
            />
          </label>
        ) : null}
        {form.action === "decide" ? (
          <label className="bx-build-filter">
            Decision{" "}
            <select
              aria-label="Decision"
              value={form.decision}
              onChange={(e) => set({ decision: e.target.value as DecisionOption })}
            >
              {(Object.keys(DECISION_LABELS) as DecisionOption[]).map((d) => (
                <option key={d} value={d}>
                  {DECISION_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {form.action === "decide" && form.decision === "resume_waive" ? (
          <label className="bx-build-filter">
            Findings to waive{" "}
            <input
              aria-label="Findings to waive"
              value={form.waive}
              placeholder="F-1, F-2"
              onChange={(e) => set({ waive: e.target.value })}
            />
          </label>
        ) : null}
        <label className="bx-build-filter">
          Push answer{" "}
          <select
            aria-label="Push answer"
            value={form.push}
            onChange={(e) => set({ push: e.target.value as ResolveForm["push"] })}
          >
            <option value="">No answer</option>
            <option value="yes">Push and open the pull request</option>
            <option value="no">Don't push</option>
          </select>
        </label>
      </div>
      <textarea
        aria-label="Note"
        rows={2}
        value={form.note}
        placeholder={
          form.action === "clarify"
            ? "The clarification, which the task's next attempt gets."
            : "Why (optional)."
        }
        onChange={(e) => set({ note: e.target.value })}
      />
      <div className="bx-build-filters">
        <Button type="submit" disabled={busy || !request}>
          Resolve
        </Button>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
        {error ? (
          <span className="bx-dim" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </form>
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
  rows: readonly (UsageTotals & { name: string; tokensOnly?: boolean })[];
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
              <td>
                {r.tokensOnly
                  ? `${integer.format(r.calls)} turn${r.calls === 1 ? "" : "s"}`
                  : integer.format(r.calls)}
              </td>
              <td>{integer.format(r.tokensIn)}</td>
              <td>{integer.format(r.tokensOut)}</td>
              <td>{r.tokensOnly ? "Tokens only" : dollars.format(r.costEstimate)}</td>
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

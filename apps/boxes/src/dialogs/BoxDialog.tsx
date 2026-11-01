// The New Box dialog, also used to edit a box and to fork its conversation.
import {
  EffortSchema,
  boxWorkDir,
  type AccountView,
  type BoxView,
  type ConversationSummary,
  type Effort,
  type GlobalSettings,
  type Mount,
  type Platform,
  type Project,
  type SecretRef,
  type SshRemote,
} from "@agentbox/contracts";
import { Button, Collapsible, Dialog, errorMessage, useApiClient, useInFlight } from "@agentbox/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { SecretsPicker } from "../components/SecretsPicker";
import { mountProblems, tcpMapProblems, toTcpMaps } from "../logic/mounts";
import {
  refsToSave,
  secretProblems,
  selectionFromRefs,
  type SecretSelection,
} from "../logic/secrets";
import {
  adopting,
  autoFillName,
  conversationLabel,
  conversationTooltip,
  defaultLayout,
  formFromBox,
  normalizeDir,
  projectForDir,
  slugify,
  validateForm,
  worktreeAllowed,
  type BoxForm,
  type DialogMode,
  type Layout,
} from "../logic/newBox";
import { PLATFORMS, platformLabel } from "../logic/status";
import { useDirectoryPicker } from "./DirectoryPicker";

export interface BoxDialogResult {
  form: BoxForm;
  /** The project settings edited in the dialog, or `null` when unchanged. */
  project: { tcpMaps: { host: number; container: number }[]; mounts: Mount[] } | null;
  /** Whether the person chose the model and the effort by hand. */
  handPicked: { model: boolean; effort: boolean };
  /** The project's secret references to save, or `null` when the ticks did not change. */
  secretRefs: SecretRef[] | null;
}

export interface BoxDialogProps {
  mode: DialogMode;
  /** The box to edit or fork from. */
  source?: BoxView;
  projects: Project[];
  settings: GlobalSettings | null;
  initialDir: string;
  /** Saves the dialog; resolves to an error message to show, or `null` to close. */
  onAccept: (result: BoxDialogResult) => Promise<string | null>;
  onCancel: () => void;
  onManageRemotes: () => void;
}

interface PortRow {
  host: string;
  container: string;
}

const efforts = EffortSchema.options;

const titles: Record<DialogMode, string> = {
  new: "New Box",
  edit: "Edit Box",
  fork: "Fork Conversation",
};

export function BoxDialog(props: BoxDialogProps) {
  const { mode, source, projects, settings } = props;
  const client = useApiClient();
  const fallback = { model: "claude-opus-5-5", effort: "high" as Effort };
  const [form, setForm] = useState<BoxForm>(() =>
    source
      ? formFromBox(source.box, mode === "edit" ? "edit" : "fork", fallback)
      : {
          platform: "claude",
          targetDir: props.initialDir,
          conversation: "",
          name: "",
          model: fallback.model,
          effort: fallback.effort,
          layout: defaultLayout(
            props.initialDir,
            settings,
            projectForDir(projects, props.initialDir),
          ),
          skipPermissions: true,
          account: "",
          sshRemoteRefs: [],
        },
  );
  // The name the dialog filled in last; a ref, so the directory effect sees it.
  const lastAuto = useRef<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<SshRemote[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const { busy, run } = useInFlight();
  // In edit and fork mode, a model or effort the record leaves to the
  // settings files follows them, as in New Box, until the person picks one.
  const touched = useRef({
    model: mode !== "new" && source?.box.model !== undefined,
    effort: mode !== "new" && source?.box.effort !== undefined,
    layout: mode === "edit",
  });
  const handPicked = useRef({ model: false, effort: false });

  const dir = normalizeDir(form.targetDir);
  const project =
    projectForDir(projects, dir) ??
    (source ? projects.find((p) => p.id === source.box.projectId) : undefined);
  const [ports, setPorts] = useState<PortRow[]>(() =>
    (project?.tcpMaps ?? []).map((m) => ({ host: String(m.host), container: String(m.container) })),
  );
  const [mounts, setMounts] = useState<PortRow[]>(() =>
    (project?.mounts ?? []).map((m) => ({
      host: m.host,
      container: m.container === m.host ? "" : m.container,
    })),
  );
  const [projectTouched, setProjectTouched] = useState(false);
  // The project's secret references the person ticked. They follow the
  // project of the target directory until the person changes a tick.
  const [secretSel, setSecretSel] = useState<SecretSelection>(() =>
    selectionFromRefs(project?.secretRefs ?? []),
  );
  const [secretsTouched, setSecretsTouched] = useState(false);
  const projectSecretsKey = JSON.stringify(project?.secretRefs ?? []);
  useEffect(() => {
    if (!secretsTouched) setSecretSel(selectionFromRefs(project?.secretRefs ?? []));
  }, [projectSecretsKey, secretsTouched]);

  const set = <K extends keyof BoxForm>(key: K, value: BoxForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Whether the target directory holds an executable new-issue.sh.
  const [newIssueScript, setNewIssueScript] = useState(false);

  // The directory the conversation list and the settings files come from.
  const catalogDir = source && mode === "edit" ? boxWorkDir(source.box) : dir;
  const lastCatalogDir = useRef(catalogDir);
  useEffect(() => {
    // A conversation picked in another directory has no transcript in this
    // one: drop it, and the name filled in from it, so the combo and the
    // form agree. Edit mode never changes the directory.
    if (lastCatalogDir.current !== catalogDir) {
      lastCatalogDir.current = catalogDir;
      if (mode !== "edit") {
        const r = autoFillName(form.name, lastAuto.current, null);
        lastAuto.current = r.lastAuto;
        setForm((f) => ({ ...f, conversation: "", name: r.name }));
      }
    }
    if (!catalogDir.startsWith("/")) {
      setConversations([]);
      setNewIssueScript(false);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      client
        .call("conversations.list", { query: { dir: catalogDir } })
        .then((r) => live && setConversations(r.conversations))
        .catch(() => live && setConversations([]));
      client
        .call("models.list", {
          query: {
            dir: catalogDir,
            ...(form.platform === "claude" && form.account !== "" ? { account: form.account } : {}),
          },
        })
        .then((r) => {
          if (!live) return;
          setModels(r.models);
          // Re-resolve the defaults on a directory change until the person picks by hand.
          setForm((f) => ({
            ...f,
            ...(touched.current.model ? {} : { model: r.defaults.model }),
            ...(touched.current.effort ? {} : { effort: r.defaults.effort }),
          }));
        })
        .catch(() => undefined);
      if (mode === "new") {
        client
          .call("fs.dirs", { query: { path: catalogDir } })
          .then((r) => live && setNewIssueScript(r.newIssueScript === true))
          .catch(() => live && setNewIssueScript(false));
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, catalogDir, mode, form.platform, form.account]);

  useEffect(() => {
    client
      .call("accounts.list", {})
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    client
      .call("sshRemotes.list", {})
      .then((r) => setRemotes(r.remotes.map((v) => v.remote)))
      .catch(() => setRemotes([]));
  }, [client]);

  // A new directory brings its remembered layout and its project's settings.
  const lastDir = useRef(dir);
  useEffect(() => {
    if (!touched.current.layout) {
      const layout = defaultLayout(dir, settings, project, newIssueScript);
      setForm((f) => (f.layout === layout ? f : { ...f, layout }));
    }
    if (lastDir.current === dir) return;
    lastDir.current = dir;
    if (!projectTouched) {
      setPorts(
        (project?.tcpMaps ?? []).map((m) => ({
          host: String(m.host),
          container: String(m.container),
        })),
      );
      setMounts(
        (project?.mounts ?? []).map((m) => ({
          host: m.host,
          container: m.container === m.host ? "" : m.container,
        })),
      );
    }
  }, [dir, settings, project, projectTouched, newIssueScript]);

  const claude = form.platform === "claude";
  const vendorAccounts = accounts.filter((a) => a.account.vendor === form.platform);
  const defaultAccount = settings?.accountDefaults[form.platform];
  const conversationDisabled = !claude || mode === "fork";
  const knownUuid = conversations.some((c) => c.sessionUuid === form.conversation);
  const picked = conversations.find((c) => c.sessionUuid === form.conversation) ?? null;
  const modelOptions = useMemo(
    () => [...new Set([...models, ...(form.model ? [form.model] : [])])],
    [models, form.model],
  );

  const pickConversation = (uuid: string) => {
    const c = conversations.find((x) => x.sessionUuid === uuid) ?? null;
    if (mode === "edit") {
      set("conversation", uuid);
      return;
    }
    const r = autoFillName(form.name, lastAuto.current, c);
    lastAuto.current = r.lastAuto;
    setForm((f) => ({ ...f, conversation: uuid, name: r.name }));
  };

  const submit = () =>
    run(async () => {
      const problems = validateForm(form, mode);
      const portRows = ports.filter((r) => r.host.trim() !== "" || r.container.trim() !== "");
      const mountList: Mount[] = mounts
        .filter((r) => r.host.trim() !== "")
        .map((r) => ({ host: r.host.trim(), container: r.container.trim() || r.host.trim() }));
      if (projectTouched) {
        problems.push(...tcpMapProblems(portRows), ...mountProblems(mountList));
      }
      if (secretsTouched) problems.push(...secretProblems(secretSel));
      setErrors(problems);
      if (problems.length > 0) return;
      try {
        const err = await props.onAccept({
          secretRefs: secretsTouched ? refsToSave(secretSel, project?.secretRefs ?? []) : null,
          form,
          project: projectTouched ? { tcpMaps: toTcpMaps(portRows), mounts: mountList } : null,
          handPicked: { ...handPicked.current },
        });
        if (err) setErrors([err]);
      } catch (err) {
        setErrors([errorMessage(err)]);
      }
    });

  const slug = slugify(form.name);
  const adopt = adopting(form, mode);
  const layoutHint = adopt
    ? "Resuming an existing conversation: no workspace folder or worktree is created."
    : form.layout === "worktree"
      ? slug
        ? `Worktree .worktrees/${slug} on branch claude/${slug}.`
        : "Type a conversation name to name the worktree."
      : form.layout === "workspace"
        ? slug
          ? `Workspace folder ${slug}/ in the directory.`
          : "Type a conversation name to name the folder."
        : "The agent works in the directory itself.";

  const picker = useDirectoryPicker();
  const browse = async (current: string, apply: (p: string) => void) => {
    const picked = await picker.pick(current || undefined);
    if (picked) apply(picked);
  };

  return (
    <Dialog
      title={titles[mode]}
      width="min(720px, 94vw)"
      onClose={props.onCancel}
      onSubmit={() => void submit()}
      busy={busy}
      buttons={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button primary onClick={() => void submit()}>
            {mode === "edit" ? "Save" : mode === "fork" ? "Fork" : "Create"}
          </Button>
        </>
      }
    >
      <div className="ab-field">
        <label htmlFor="bx-platform">Platform</label>
        <select
          id="bx-platform"
          className="ab-select"
          value={form.platform}
          disabled={mode === "edit"}
          onChange={(e) => {
            const p = e.target.value as Platform;
            setForm((f) => ({
              ...f,
              platform: p,
              account: "",
              ...(p !== "claude" ? { conversation: "" } : {}),
            }));
          }}
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {platformLabel[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="ab-field">
        <label htmlFor="bx-account">Account</label>
        <select
          id="bx-account"
          className="ab-select"
          value={form.account}
          onChange={(e) => set("account", e.target.value)}
        >
          <option value="">
            {defaultAccount ? `Default (${defaultAccount})` : "Default (none set)"}
          </option>
          {form.account !== "" && !vendorAccounts.some((a) => a.account.id === form.account) && (
            <option value={form.account}>{form.account}</option>
          )}
          {vendorAccounts.map((a) => (
            <option key={a.account.id} value={a.account.id}>
              {a.account.id}
              {a.account.label !== a.account.name ? ` (${a.account.label})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="ab-hint bx-indent">
        {settings?.accountsMode === "accounts"
          ? mode === "edit"
            ? "A change takes effect when the box restarts. Claude conversations carry over; Codex and Copilot start a new session."
            : "The box runs this CLI with the account's own sign-in and settings."
          : "Accounts mode is off, so boxes use the host's agent folders and ignore this choice."}
      </div>
      <div className="ab-field">
        <label htmlFor="bx-dir">Target directory</label>
        <div className="bx-row">
          <input
            id="bx-dir"
            className="ab-input bx-grow"
            value={form.targetDir}
            disabled={mode !== "new"}
            placeholder="/home/you/project"
            onChange={(e) => set("targetDir", e.target.value)}
          />
          {mode === "new" && (
            <Button onClick={() => void browse(form.targetDir, (p) => set("targetDir", p))}>
              Browse...
            </Button>
          )}
        </div>
      </div>
      <div className="ab-field">
        <label htmlFor="bx-conversation">Conversation</label>
        <select
          id="bx-conversation"
          className="ab-select"
          value={form.conversation}
          disabled={conversationDisabled}
          title={picked ? conversationTooltip(picked) : undefined}
          onChange={(e) => pickConversation(e.target.value)}
        >
          <option value="">
            {mode === "edit"
              ? "Start a new conversation on next restart"
              : "Start a new conversation"}
          </option>
          {mode === "edit" && form.conversation !== "" && !knownUuid && (
            <option value={form.conversation}>
              Current: {form.conversation} (no transcript found)
            </option>
          )}
          {conversations.map((c) => (
            <option key={c.sessionUuid} value={c.sessionUuid} title={conversationTooltip(c)}>
              {conversationLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <div className="ab-hint bx-indent">
        {mode === "fork" && source
          ? `The fork starts a new session copied from "${source.box.conversationName}". The source conversation stays as it is.`
          : !claude
            ? `${platformLabel[form.platform]} always starts a new conversation.`
            : picked
              ? `Resumes session ${picked.sessionUuid}${picked.lastPrompt ? `. Last prompt: ${picked.lastPrompt}` : ""}`
              : mode === "edit"
                ? "Pick another conversation to relink this box; it takes effect on the next start."
                : "A new session starts with a fresh session id."}
      </div>
      <div className="ab-field">
        <label htmlFor="bx-name">Conversation name</label>
        <input
          id="bx-name"
          className="ab-input"
          value={form.name}
          placeholder="Name of the conversation, such as Emails not sending"
          onChange={(e) => set("name", e.target.value)}
        />
      </div>
      <div className="ab-field">
        <label htmlFor="bx-model">Model</label>
        <input
          id="bx-model"
          className="ab-input"
          list="bx-models"
          value={claude ? form.model : ""}
          disabled={!claude}
          onChange={(e) => {
            touched.current.model = true;
            handPicked.current.model = true;
            set("model", e.target.value);
          }}
        />
        <datalist id="bx-models">
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <div className="ab-field">
        <label htmlFor="bx-effort">Effort</label>
        <select
          id="bx-effort"
          className="ab-select"
          value={form.effort}
          disabled={!claude}
          onChange={(e) => {
            touched.current.effort = true;
            handPicked.current.effort = true;
            set("effort", e.target.value as Effort);
          }}
        >
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="ab-group bx-layout" disabled={mode === "edit" || adopt}>
        <legend className="bx-dim">Where the agent works</legend>
        {(
          [
            ["worktree", "In a git worktree on its own branch", !worktreeAllowed(project)],
            ["workspace", "In a workspace subfolder named after the conversation", false],
            ["root", "In the directory itself", false],
          ] as [Layout, string, boolean][]
        ).map(([value, label, disabled]) => (
          <label key={value} className={`ab-checkbox${disabled ? " ab-disabled" : ""}`}>
            <input
              type="radio"
              name="bx-layout"
              value={value}
              checked={form.layout === value}
              disabled={disabled}
              onChange={() => {
                touched.current.layout = true;
                set("layout", value);
              }}
            />
            {label}
            {value === "worktree" && disabled && (
              <span className="bx-dim"> (the project has no git repository)</span>
            )}
          </label>
        ))}
        <div className="ab-hint">{layoutHint}</div>
      </fieldset>
      <label className="ab-checkbox">
        <input
          type="checkbox"
          checked={form.skipPermissions}
          onChange={(e) => set("skipPermissions", e.target.checked)}
        />
        Allow bypassing permission prompts (--allow-dangerously-skip-permissions; starts in auto
        mode)
      </label>
      <Collapsible title="TCP port maps (project)">
        <div className="ab-hint">
          Dev servers need no map: their links appear in the details panel. Maps apply to every box
          in the project&apos;s container and take effect when it restarts. An empty box port
          mirrors the host port.
        </div>
        {ports.map((r, i) => (
          <div key={i} className="bx-row">
            <input
              className="ab-input"
              aria-label={`Host port ${i + 1}`}
              placeholder="Host port"
              value={r.host}
              onChange={(e) => {
                setProjectTouched(true);
                setPorts((all) =>
                  all.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)),
                );
              }}
            />
            <input
              className="ab-input"
              aria-label={`Box port ${i + 1}`}
              placeholder="Box port"
              value={r.container}
              onChange={(e) => {
                setProjectTouched(true);
                setPorts((all) =>
                  all.map((x, j) => (j === i ? { ...x, container: e.target.value } : x)),
                );
              }}
            />
            <Button
              aria-label={`Remove port ${i + 1}`}
              onClick={() => {
                setProjectTouched(true);
                setPorts((all) => all.filter((_x, j) => j !== i));
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button onClick={() => setPorts((all) => [...all, { host: "", container: "" }])}>
            Add port
          </Button>
        </div>
      </Collapsible>
      <Collapsible title="Remote port forwarding">
        {remotes.length === 0 && <div className="ab-hint">No SSH remotes yet.</div>}
        {remotes.map((r) => (
          <label key={r.name} className="ab-checkbox">
            <input
              type="checkbox"
              checked={form.sshRemoteRefs.includes(r.name)}
              onChange={(e) =>
                set(
                  "sshRemoteRefs",
                  e.target.checked
                    ? [...form.sshRemoteRefs, r.name]
                    : form.sshRemoteRefs.filter((n) => n !== r.name),
                )
              }
            />
            {r.name}{" "}
            <span className="bx-dim">
              {r.host} ({r.forwards.length} forwards)
            </span>
          </label>
        ))}
        <div>
          <Button onClick={props.onManageRemotes}>Manage Remotes...</Button>
        </div>
      </Collapsible>
      <Collapsible title="Add folders to sandbox (project)">
        <div className="ab-hint">
          Mounts apply to every box in the project&apos;s container. The host folder must exist. An
          empty box path mirrors the host path.
        </div>
        {mounts.map((r, i) => (
          <div key={i} className="bx-row">
            <input
              className="ab-input bx-grow"
              aria-label={`Host folder ${i + 1}`}
              placeholder="Host folder"
              value={r.host}
              onChange={(e) => {
                setProjectTouched(true);
                setMounts((all) =>
                  all.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)),
                );
              }}
            />
            <Button
              onClick={() =>
                void browse(r.host, (p) => {
                  setProjectTouched(true);
                  setMounts((all) => all.map((x, j) => (j === i ? { ...x, host: p } : x)));
                })
              }
            >
              Browse...
            </Button>
            <input
              className="ab-input bx-grow"
              aria-label={`Box folder ${i + 1}`}
              placeholder="Box path (same as host)"
              value={r.container}
              onChange={(e) => {
                setProjectTouched(true);
                setMounts((all) =>
                  all.map((x, j) => (j === i ? { ...x, container: e.target.value } : x)),
                );
              }}
            />
            <Button
              aria-label={`Remove folder ${i + 1}`}
              onClick={() => {
                setProjectTouched(true);
                setMounts((all) => all.filter((_x, j) => j !== i));
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button onClick={() => setMounts((all) => [...all, { host: "", container: "" }])}>
            Add folder
          </Button>
        </div>
      </Collapsible>
      <Collapsible title="Secrets (project)">
        <SecretsPicker
          selection={secretSel}
          globalRefs={settings?.secretRefs ?? []}
          projectName={project?.name ?? null}
          onChange={(next) => {
            setSecretsTouched(true);
            setSecretSel(next);
          }}
        />
      </Collapsible>
      {errors.length > 0 && (
        <div role="alert" className="ab-error-text">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      {picker.element}
    </Dialog>
  );
}

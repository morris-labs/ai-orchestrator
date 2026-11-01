// The prompt templates editor: four tabs, each with its placeholders, Reset
// to default, and an empty template that turns the prompt off.
import type { PromptTemplates } from "@aio/contracts";
import { Button, Dialog, errorMessage, useApiClient } from "@aio/ui";
import { useEffect, useState } from "react";

type Key = keyof PromptTemplates;

export const promptTabs: { key: Key; label: string; help: string }[] = [
  {
    key: "workspace",
    label: "Workspace subfolder",
    help: "%1 slug, %2 conversation name as typed, %3 workspace path, %4 notes directory, %5 INFRA.md path.",
  },
  { key: "portHint", label: "Port hint", help: "%1 the list of mapped ports." },
  {
    key: "starter",
    label: "Starter",
    help: "%1 conversation name, %2 target directory as the box sees it.",
  },
  {
    key: "worktree",
    label: "Worktree",
    help: "%1 slug, %2 conversation name, %3 worktree path, %4 notes directory, %5 INFRA.md path, %6 primary repository, %7 branch.",
  },
];

export function PromptsDialog({ onClose }: { onClose: () => void }) {
  const client = useApiClient();
  const [templates, setTemplates] = useState<PromptTemplates | null>(null);
  const [defaults, setDefaults] = useState<PromptTemplates | null>(null);
  const [tab, setTab] = useState<Key>("workspace");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .call("prompts.get", {})
      .then((r) => {
        setTemplates(r.templates);
        setDefaults(r.defaults);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [client]);

  const save = async () => {
    if (!templates) return;
    try {
      await client.call("prompts.put", { body: templates });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const current = promptTabs.find((t) => t.key === tab) ?? promptTabs[0];
  return (
    <Dialog
      title="Edit Prompts"
      width="min(820px, 94vw)"
      onClose={onClose}
      buttons={
        <>
          <Button
            className="ab-left"
            disabled={!defaults || !templates || templates[tab] === defaults[tab]}
            onClick={() =>
              defaults && templates && setTemplates({ ...templates, [tab]: defaults[tab] })
            }
          >
            Reset to default
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary disabled={!templates} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="ab-tabbar" role="tablist">
        {promptTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`ab-tab${t.key === tab ? " ab-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current && (
        <div className="ab-hint">
          Placeholders: {current.help} Leave the template empty to turn this prompt off.
        </div>
      )}
      <textarea
        aria-label={`${current?.label ?? ""} template`}
        className="ab-textarea"
        rows={18}
        value={templates?.[tab] ?? ""}
        disabled={!templates}
        onChange={(e) => templates && setTemplates({ ...templates, [tab]: e.target.value })}
      />
      {templates && templates[tab] === "" && <div className="ab-hint">This prompt is off.</div>}
      {error && (
        <div role="alert" className="ab-error-text">
          {error}
        </div>
      )}
    </Dialog>
  );
}

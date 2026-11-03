import { DEFAULT_POLICY } from "@aio/contracts";
import { act } from "@testing-library/react";
import { parse } from "yaml";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FakeApiError } from "@aio/ui/testing";
import { describe, expect, it, vi } from "vitest";
import { Policy } from "../src/screens/Policy.js";
import { useRoute } from "../src/state/router.js";
import { StoreProvider } from "../src/state/store.js";
import { PROJECT, project } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";

const stored = {
  ...DEFAULT_POLICY,
  riskPaths: ["src/auth/**"],
  rules: [{ id: "no-phi", text: "Never log patient data." }],
  tests: [{ command: "npm test" }],
};

function RouteProbe() {
  return <span data-testid="route">{useRoute().name}</span>;
}

/** The policy a put sends: the text, parsed. */
function sent(body: unknown): unknown {
  return parse((body as { text: string }).text);
}

function handlers(text?: string) {
  return {
    "projects.list": () => ({ projects: [project] }),
    "projects.policy.get": () => ({
      path: "/home/user/src/example-app/.aio/policy.yaml",
      exists: true,
      policy: stored,
      ...(text !== undefined ? { text, revision: "sha256:one" } : {}),
    }),
    "projects.policy.put": (c: { body: unknown }) => {
      const t = (c.body as { text: string }).text;
      return {
        path: "/p/policy.yaml",
        exists: true,
        policy: { ...DEFAULT_POLICY, ...(parse(t) as object) },
        text: t,
        revision: "sha256:two",
      };
    },
  };
}

describe("Policy", () => {
  it("loads the policy into the form and saves edits", async () => {
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, handlers());
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    expect(screen.getByLabelText("Rule 1 text")).toHaveValue("Never log patient data.");
    fireEvent.change(screen.getByLabelText(/^Risk paths/), {
      target: { value: "src/auth/**\nsrc/billing/**" },
    });
    fireEvent.change(screen.getByLabelText(/^Group size limit/), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(1));
    expect(sent(server.callsTo("projects.policy.put")[0]!.body)).toMatchObject({
      version: 1,
      riskPaths: ["src/auth/**", "src/billing/**"],
      groupSizeLimit: 250,
      tests: [{ command: "npm test" }],
    });
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it("leaves groupSizeLimit out of the file when it is the default or unchanged", async () => {
    const file = "version: 1\nriskPaths:\n  - src/auth/**\n";
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, handlers(file));
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    fireEvent.change(screen.getByLabelText(/^Risk paths/), { target: { value: "src/**" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(1));
    const put = server.callsTo("projects.policy.put")[0]!;
    expect((put.body as { text: string }).text).not.toContain("groupSizeLimit");
  });

  it("edits raw YAML and refuses an invalid file", async () => {
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, handlers());
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const yaml = screen.getByLabelText("Policy YAML");
    expect((yaml as HTMLTextAreaElement).value).toContain("src/auth/**");
    fireEvent.change(yaml, { target: { value: "version: 1\nrisk_paths: []\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Unrecognized key/)).toBeInTheDocument();
    expect(server.callsTo("projects.policy.put")).toHaveLength(0);
    fireEvent.change(yaml, { target: { value: "version: 1\nlint:\n  - command: npm run lint\n" } });
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    expect(screen.getByLabelText("Lint 1 command")).toHaveValue("npm run lint");
  });

  it("keeps commas and spaces while a glob list is typed key by key", async () => {
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, handlers());
    const input = await screen.findByLabelText<HTMLInputElement>("Rule 1 applies to");
    // Each key appends to what the field shows, as a person typing would.
    for (const ch of "src/**, lib/**") {
      fireEvent.change(input, { target: { value: input.value + ch } });
    }
    expect(input).toHaveValue("src/**, lib/**");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(1));
    expect(sent(server.callsTo("projects.policy.put")[0]!.body)).toMatchObject({
      rules: [{ id: "no-phi", appliesTo: ["src/**", "lib/**"] }],
    });
  });

  it("keeps the file's comments through a form save and a YAML edit", async () => {
    const file =
      "# keep in sync with CI\nversion: 1\nriskPaths:\n  - src/auth/** # the login code\nrules:\n  - id: no-phi\n    text: Never log patient data.\ntests:\n  - command: npm test\n";
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, handlers(file));
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const yaml = screen.getByLabelText<HTMLTextAreaElement>("Policy YAML");
    expect(yaml.value).toBe(file);
    fireEvent.change(yaml, { target: { value: `${yaml.value}# typed here\n` } });
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    fireEvent.change(screen.getByLabelText(/^Group size limit/), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(1));
    const put = server.callsTo("projects.policy.put")[0]!;
    const text = (put.body as { text: string }).text;
    expect(text).toContain("# keep in sync with CI");
    expect(text).toContain("# the login code");
    expect(text).toContain("# typed here");
    expect(sent(put.body)).toMatchObject({ groupSizeLimit: 250, riskPaths: ["src/auth/**"] });
    expect(put.query.baseRevision).toBe("sha256:one");
  });

  it("asks to reload or overwrite when the file changed on disk", async () => {
    const { server } = renderWithStore(<Policy projectId={PROJECT} />, {
      ...handlers("version: 1\n"),
      "projects.policy.put": (c: { query: Record<string, unknown>; body: unknown }) => {
        if (c.query.baseRevision) {
          throw new FakeApiError("conflict", "The policy file changed on disk.", 409);
        }
        const t = (c.body as { text: string }).text;
        return {
          path: "/p/policy.yaml",
          exists: true,
          policy: DEFAULT_POLICY,
          text: t,
          revision: "sha256:three",
        };
      },
    });
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    fireEvent.change(screen.getByLabelText(/^Group size limit/), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/changed on disk since you opened it/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(2));
    expect(server.callsTo("projects.policy.put")[1]!.query.baseRevision).toBeUndefined();
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it("hides Saved after a further edit and asks before leaving unsaved edits", async () => {
    window.location.hash = "#/policy";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { server } = renderWithStore(
      <>
        <RouteProbe />
        <Policy projectId={PROJECT} />
      </>,
      handlers(),
    );
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/auth/**"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("projects.policy.put")).toHaveLength(1));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Group size limit/), { target: { value: "250" } });
    expect(screen.queryByText(/Saved/)).toBeNull();
    expect(screen.getByText("Unsaved changes.")).toBeInTheDocument();
    await act(async () => {
      window.location.hash = "#/runs";
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("route")).toHaveTextContent("policy");
    expect(window.location.hash).toBe("#/policy");
    confirm.mockReturnValue(true);
    await act(async () => {
      window.location.hash = "#/runs";
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(screen.getByTestId("route")).toHaveTextContent("runs");
    confirm.mockRestore();
  });
});

describe("Policy project switch", () => {
  const OTHER = "other-app-9f8e7d6c";
  const otherProject = {
    ...project,
    project: { ...project.project, id: OTHER, name: "other-app", root: "/home/user/src/other-app" },
  };
  const policyA = {
    path: "/home/user/src/example-app/.aio/policy.yaml",
    exists: true,
    policy: { ...stored, riskPaths: ["SYNTHETIC_A/**"] },
  };

  function twoProjects(otherPolicy: () => unknown) {
    return {
      ...handlers(),
      "projects.list": () => ({ projects: [project, otherProject] }),
      "projects.policy.get": (c: { params: Record<string, string> }) =>
        c.params.projectId === OTHER ? otherPolicy() : policyA,
    };
  }

  function showProject(r: ReturnType<typeof renderWithStore>, projectId: string) {
    r.rerender(
      <StoreProvider store={r.store}>
        <Policy projectId={projectId} />
      </StoreProvider>,
    );
  }

  it("refuses to save when the selected project's policy fails to load", async () => {
    const r = renderWithStore(
      <Policy projectId={PROJECT} />,
      twoProjects(() => {
        throw new FakeApiError("validation", "policy.yaml: SYNTHETIC broken", 400);
      }),
    );
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("SYNTHETIC_A/**"));
    showProject(r, OTHER);
    await screen.findByText(/SYNTHETIC broken/);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.server.callsTo("projects.policy.put")).toHaveLength(0);
  });

  it("ignores a late load for a project it switched away from", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = renderWithStore(
      <Policy projectId={OTHER} />,
      twoProjects(async () => {
        await gate;
        return { ...policyA, policy: { ...stored, riskPaths: ["SYNTHETIC_B/**"] } };
      }),
    );
    showProject(r, PROJECT);
    await waitFor(() => expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("SYNTHETIC_A/**"));
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("SYNTHETIC_A/**");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.server.callsTo("projects.policy.put")).toHaveLength(1));
    const put = r.server.callsTo("projects.policy.put")[0]!;
    expect(put.params.projectId).toBe(PROJECT);
    expect(sent(put.body)).toMatchObject({ riskPaths: ["SYNTHETIC_A/**"] });
  });
});

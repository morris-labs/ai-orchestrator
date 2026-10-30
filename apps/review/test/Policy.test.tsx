import { DEFAULT_POLICY } from "@agentbox/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FakeApiError } from "@agentbox/ui/testing";
import { describe, expect, it } from "vitest";
import { Policy } from "../src/screens/Policy.js";
import { StoreProvider } from "../src/state/store.js";
import { PROJECT, project } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";

const stored = {
  ...DEFAULT_POLICY,
  riskPaths: ["src/auth/**"],
  rules: [{ id: "no-phi", text: "Never log patient data." }],
  tests: [{ command: "npm test" }],
};

function handlers() {
  return {
    "projects.list": () => ({ projects: [project] }),
    "projects.policy.get": () => ({
      path: "/home/user/src/example-app/.claude-box/policy.yaml",
      exists: true,
      policy: stored,
    }),
    "projects.policy.put": (c: { body: unknown }) => ({
      path: "/p/policy.yaml",
      exists: true,
      policy: c.body,
    }),
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
    expect(server.callsTo("projects.policy.put")[0]!.body).toMatchObject({
      version: 1,
      riskPaths: ["src/auth/**", "src/billing/**"],
      groupSizeLimit: 250,
      tests: [{ command: "npm test" }],
    });
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
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
    expect(server.callsTo("projects.policy.put")[0]!.body).toMatchObject({
      rules: [{ id: "no-phi", appliesTo: ["src/**", "lib/**"] }],
    });
  });
});

describe("Policy project switch", () => {
  const OTHER = "other-app-9f8e7d6c";
  const otherProject = {
    ...project,
    project: { ...project.project, id: OTHER, name: "other-app", root: "/home/user/src/other-app" },
  };
  const policyA = {
    path: "/home/user/src/example-app/.claude-box/policy.yaml",
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
    expect(put.body).toMatchObject({ riskPaths: ["SYNTHETIC_A/**"] });
  });
});

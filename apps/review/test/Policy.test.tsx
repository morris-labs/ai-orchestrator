import { DEFAULT_POLICY } from "@agentbox/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Policy } from "../src/screens/Policy.js";
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
});

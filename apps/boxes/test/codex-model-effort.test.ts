// Issue #48: the Boxes dialog sends a Codex box's model and effort.
import { makeBox } from "@aio/ui/testing";
import { describe, expect, it } from "vitest";
import { createBody, formFromBox, updateBody, type BoxForm } from "../src/logic/newBox";

const codexForm: BoxForm = {
  platform: "codex",
  targetDir: "/w/site",
  conversation: "",
  name: "",
  model: "gpt-6.1-sol",
  effort: "high",
  layout: "root",
  skipPermissions: true,
  account: "",
  sshRemoteRefs: [],
};

describe("Codex model and effort in the box dialog", () => {
  it("sends the model and effort when it creates a Codex box", () => {
    const body = createBody(codexForm, "new");
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.effort).toBe("high");
  });

  it("sends a hand-picked model and effort when it edits a Codex box", () => {
    const box = makeBox({ id: "aio-agent-site", targetDir: "/w/site", platform: "codex" });
    const form = formFromBox(box, "edit", { model: "gpt-6.1-sol", effort: "high" });
    const edited: BoxForm = { ...form, model: "gpt-6.1-terra", effort: "medium" };
    expect(updateBody(box, edited, { model: true, effort: true })).toMatchObject({
      model: "gpt-6.1-terra",
      effort: "medium",
    });
  });
});

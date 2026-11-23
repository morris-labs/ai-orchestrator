// A build's agents reach the team chat: the engine attaches the bus to each
// seat call with that agent's token, and the agent's messages land in the
// build's `messages/` directory and event stream.
import { MessageSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { CART_DONE, REPORT, buildWorld } from "./harness.js";

describe("the team chat in a build", () => {
  it("saves a Developer's message with the build, seat, and task the engine knows", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
          busCalls: [
            {
              tool: "send_message",
              arguments: {
                type: "file_request",
                body: "Export a currency constant from the tax module.",
                paths: ["src/tax.mjs"],
              },
            },
          ],
        },
      ],
    });
    const started = await world.start("cart-chat");
    await world.settle("cart-chat");

    const messages = world.jsonFiles("cart-chat", "messages").map((m) => MessageSchema.parse(m));
    expect(messages).toEqual([
      expect.objectContaining({
        id: "M1",
        buildId: started.id,
        from: { kind: "seat", seat: "developer", taskId: "T1" },
        // No task of this plan owns the file, so the Project manager gets it.
        to: { kind: "seat", seat: "project-manager", taskId: null },
        type: "file_request",
        taskId: "T1",
      }),
    ]);
    expect(world.events.ofType("message.sent").map((e) => e.message)).toEqual(messages);
    expect(world.file("cart-chat", "events.jsonl")).toContain('"type":"message.sent"');
  });

  it("revokes the agent's token when its call ends", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    await world.start("cart-quiet");
    await world.settle("cart-quiet");
    expect(world.team.activeTokens()).toBe(0);
  });
});

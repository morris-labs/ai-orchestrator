import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  EventSchema,
  MESSAGE_BODY_MAX,
  MessageSchema,
  SendMessageInputSchema,
} from "../src/index.js";
import { T0 } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

const message = {
  version: 1,
  id: "M1",
  buildId: BUILD,
  from: { kind: "seat", seat: "developer", taskId: "T1" },
  to: { kind: "seat", seat: "test-engineer", taskId: "T1" },
  routing: "by_type",
  type: "test_dispute",
  taskId: "T1",
  milestone: null,
  paths: ["test/cart.test.mjs"],
  body: "The test expects a total in cents, but criterion AC1 says dollars.",
  createdAt: T0,
};

describe("team chat messages", () => {
  it("parses a message from a seat to a seat", () => {
    expect(roundTrip(MessageSchema, message)).toEqual(message);
  });

  it("parses a message to the owner", () => {
    const toOwner = { ...message, to: { kind: "owner" }, routing: "addressed" };
    expect(roundTrip(MessageSchema, toOwner).to).toEqual({ kind: "owner" });
  });

  it("refuses a message with neither a task nor a milestone", () => {
    expect(() => MessageSchema.parse({ ...message, taskId: null })).toThrow(/task or a milestone/);
  });

  it("parses a reply that names the message it replies to and its thread", () => {
    const reply = {
      ...message,
      id: "M2",
      type: "answer",
      routing: "reply",
      replyTo: "M1",
      thread: "M1",
    };
    expect(roundTrip(MessageSchema, reply)).toEqual(reply);
    expect(() => MessageSchema.parse({ ...reply, thread: undefined })).toThrow(/thread/);
  });

  it("refuses an empty or oversized body", () => {
    expect(() => MessageSchema.parse({ ...message, body: "" })).toThrow(/body/);
    const big = "x".repeat(MESSAGE_BODY_MAX + 1);
    expect(() => MessageSchema.parse({ ...message, body: big })).toThrow(/body/);
  });

  it("parses a message.sent event", () => {
    const event = {
      id: "E-1",
      time: T0,
      source: "engine:aio-agent-proj-example",
      streamId: "01JB8Z0000000000000000STRM",
      seq: 1,
      sourceSeq: 1,
      type: "message.sent",
      message,
    };
    expect(roundTrip(EventSchema, event)).toEqual(event);
    expect(EVENT_TYPES).toContain("message.sent");
  });
});

describe("send_message input", () => {
  it("takes the message that a reply replies to", () => {
    expect(
      SendMessageInputSchema.parse({ type: "answer", body: "Zero.", replyTo: "M3" }).replyTo,
    ).toBe("M3");
    expect(() =>
      SendMessageInputSchema.parse({ type: "answer", body: "Zero.", replyTo: "3" }),
    ).toThrow();
  });

  it("takes a type and a body, and nothing about the sender", () => {
    expect(SendMessageInputSchema.parse({ type: "question", body: "Which currency?" })).toEqual({
      type: "question",
      body: "Which currency?",
    });
  });

  it("refuses a sender field, so an agent can't name another seat as the sender", () => {
    for (const field of ["from", "sender", "seat"]) {
      expect(() =>
        SendMessageInputSchema.parse({ type: "question", body: "Hi", [field]: "architect" }),
      ).toThrow(new RegExp(field));
    }
  });

  it("takes a seat or the owner as the addressee", () => {
    expect(SendMessageInputSchema.parse({ type: "note", body: "Hi", to: "owner" }).to).toBe(
      "owner",
    );
    expect(SendMessageInputSchema.parse({ type: "note", body: "Hi", to: "architect" }).to).toBe(
      "architect",
    );
    expect(() => SendMessageInputSchema.parse({ type: "note", body: "Hi", to: "Arch!" })).toThrow();
  });

  it("requires the files of a file request", () => {
    expect(() => SendMessageInputSchema.parse({ type: "file_request", body: "Add x" })).toThrow(
      /paths/,
    );
  });
});

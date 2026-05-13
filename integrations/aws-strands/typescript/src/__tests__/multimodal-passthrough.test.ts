/**
 * Multimodal `RunAgentInput.messages[*].content` must be passed to
 * `agent.stream()` as `ContentBlock[]`, not flattened to a text string.
 *
 * The v1.0 Strands SDK's `InvokeArgs` accepts both `string` and
 * `ContentBlock[]`, matching the Python adapter's behavior.
 */

import { describe, it, expect } from "vitest";
import type { InputContent } from "@ag-ui/core";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/**
 * Build a stub Strands Agent whose `.stream()` records the arguments it
 * received, alongside whatever history was seeded onto `agent.messages`.
 * History reconciliation (replayHistoryIntoStrands) makes the adapter
 * call `stream(undefined)` and move the payload to `agent.messages`, so
 * tests need to inspect both to see what actually reached the LLM.
 */
function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = {
    model: {},
    messages: [] as unknown[],
    tools: [],
    toolRegistry: {
      _tools: new Map<string, unknown>(),
      add() {},
      getByName: () => undefined,
      get: () => undefined,
      removeByName() {},
      remove() {},
      values: () => [],
    },
    // eslint-disable-next-line require-yield
    async *stream(args: unknown): AsyncGenerator<AgentStreamEvent, void, void> {
      calls.push({ args, messages: [...(stub.messages as unknown[])] });
    },
  } as unknown as import("@strands-agents/sdk").Agent & { messages: unknown[] };
  return { stub, calls };
}

class Testable extends StrandsAgent {
  constructor(stub: import("@strands-agents/sdk").Agent) {
    super({ agent: stub, name: "t" });
    (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
    (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("default", stub);
  }
}

async function drain(
  agent: StrandsAgent,
  input: Parameters<StrandsAgent["run"]>[0],
) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

describe("multimodal pass-through", () => {
  it("passes ContentBlock[] to agent.stream when the message contains an image", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new Testable(stub);
    const content: InputContent[] = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-png-bytes"),
          mimeType: "image/png",
        },
      },
    ];
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    expect(calls).toHaveLength(1);
    // Replay routes multimodal content into agent.messages and calls
    // stream(undefined); the `user` turn's content carries a TextBlock +
    // ImageBlock pair (as Strands class instances after Message.fromMessageData).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.role).toBe("user");
    expect(replayed[0]!.content).toHaveLength(2);
    expect(replayed[0]!.content[0]!.type).toBe("textBlock");
    expect(replayed[0]!.content[1]!.type).toBe("imageBlock");
  });

  it("falls back to text when ALL media blocks fail conversion (unsupported MIME)", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new Testable(stub);
    const content: InputContent[] = [
      {
        type: "image",
        source: {
          type: "data",
          value: b64("anything"),
          // image/bmp is not in the allowlist — conversion will skip it.
          mimeType: "image/bmp",
        },
      },
    ];
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    expect(calls).toHaveLength(1);
    // Unsupported MIME: conversion yields zero blocks, replay falls back
    // to a text-only user turn on agent.messages.
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.content).toHaveLength(1);
    expect(replayed[0]!.content[0]!.type).toBe("textBlock");
  });

  it("preserves ContentBlock[] even when stateContextBuilder is configured", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new Testable(stub);
    // Install a stateContextBuilder that would wrap text prompts. It MUST NOT
    // be applied to multimodal prompts — the image content would be lost.
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `[STATE: wrapped] ${prompt}`,
    };
    const content: InputContent[] = [
      { type: "text", text: "describe the picture" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-jpeg"),
          mimeType: "image/jpeg",
        },
      },
    ];
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    // The builder runs on the replay path's last user-text turn, not on
    // a synthetic prompt — so the multimodal content persists as a proper
    // ContentBlock[] on agent.messages[0].content alongside any wrapped
    // text block. Assert the image survives the builder.
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed[0]!.content.some((b) => b.type === "imageBlock")).toBe(
      true,
    );
  });

  it("applies stateContextBuilder to plain-text prompts as before", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new Testable(stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `${prompt} [STATE: ok]`,
    };
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "plain text prompt" }],
      }),
    );
    // Replay routes the prompt into agent.messages[*].content[*].text, with
    // the builder's augmentation applied. The adapter calls stream(undefined).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ text?: string }>;
    }>;
    expect(replayed[0]!.content[0]!.text).toBe("plain text prompt [STATE: ok]");
  });
});

/**
 * Tests that `reasoningSignatureEvent` events are silently consumed
 * (not yielded) by the StrandsAgent adapter.
 *
 * The adapter's dispatch loop has:
 *   if (kind === "reasoningSignatureEvent") { continue; }
 *
 * These tests verify that reasoning signature events never leak into
 * the AG-UI output and that surrounding events flow correctly.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

/**
 * Build a stub Strands Agent that plays a scripted sequence of events.
 */
function scriptedAgent(events: AgentStreamEvent[]) {
  const registry = {
    _tools: new Map<string, unknown>(),
    add(t: unknown): void {
      const tool = t as { name: string };
      this._tools.set(tool.name, t);
    },
    getByName(name: string) {
      return this._tools.get(name);
    },
    get(name: string) {
      return this._tools.get(name);
    },
    removeByName(name: string) {
      this._tools.delete(name);
    },
    remove(name: unknown) {
      if (typeof name === "string") {
        this._tools.delete(name);
      } else {
        const t = name as { name?: string };
        if (t?.name) this._tools.delete(t.name);
      }
    },
    values() {
      return Array.from(this._tools.values());
    },
  };
  return {
    model: { name: "stub-model" },
    tools: [],
    toolRegistry: registry,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
  } as unknown as import("@strands-agents/sdk").Agent;
}

/**
 * Testable subclass that injects a stub directly into the per-thread cache,
 * bypassing the real `new Agent()` constructor.
 */
class TestableStrandsAgent extends StrandsAgent {
  constructor(
    stub: import("@strands-agents/sdk").Agent,
    options?: { name?: string },
  ) {
    super({ agent: stub, name: options?.name ?? "test" });
    const byThread = (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set("thread-1", stub);
    byThread.set("default", stub);
  }
}

async function collect(agent: StrandsAgent, input = minimalRunInput()) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

function types(events: unknown[]): string[] {
  return events.map((e) => (e as { type: string }).type);
}

describe("reasoning signature handling", () => {
  it("reasoning signature events are silently consumed", async () => {
    // Simulate: reasoning text delta -> reasoningSignatureEvent -> more reasoning text -> stop
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "reasoningContentDelta", text: "Let me think..." },
        } as unknown as AgentStreamEvent,
        {
          type: "reasoningSignatureEvent",
          signature: "abc123-sig-data",
        } as unknown as AgentStreamEvent,
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "reasoningContentDelta", text: " Done thinking." },
        } as unknown as AgentStreamEvent,
        { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "Here is my answer." },
        } as unknown as AgentStreamEvent,
      ]),
    );

    const input = minimalRunInput({
      threadId: "thread-1",
      runId: "r1",
      messages: [{ id: "1", role: "user", content: "hi" }],
      tools: [],
    });
    const events = await collect(agent, input);
    const kinds = types(events);

    // No event should reference the reasoning signature
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("reasoningSignature");
      expect(serialized).not.toContain("reasoning_signature");
    }
    expect(kinds).not.toContain("reasoningSignatureEvent");

    // Reasoning text before and after the signature event should still flow
    const reasoningContents = events.filter(
      (e) =>
        (e as { type: string }).type === EventType.REASONING_MESSAGE_CONTENT,
    ) as { delta: string }[];
    expect(reasoningContents).toHaveLength(2);
    expect(reasoningContents[0].delta).toBe("Let me think...");
    expect(reasoningContents[1].delta).toBe(" Done thinking.");

    // Text message after reasoning also flows correctly
    const textContents = events.filter(
      (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
    ) as { delta: string }[];
    expect(textContents).toHaveLength(1);
    expect(textContents[0].delta).toBe("Here is my answer.");
  });

  it("reasoning signature does not interrupt text streaming", async () => {
    // Simulate: text delta -> reasoningSignatureEvent -> more text delta -> stop
    // The signature sits between two text deltas that should both flow uninterrupted.
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "Hello " },
        } as unknown as AgentStreamEvent,
        {
          type: "reasoningSignatureEvent",
          signature: "xyz-signature-payload",
        } as unknown as AgentStreamEvent,
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "world!" },
        } as unknown as AgentStreamEvent,
      ]),
    );

    const input = minimalRunInput({
      threadId: "thread-1",
      runId: "r1",
      messages: [{ id: "1", role: "user", content: "hi" }],
      tools: [],
    });
    const events = await collect(agent, input);
    const kinds = types(events);

    // Text message lifecycle should be intact
    expect(kinds).toContain(EventType.TEXT_MESSAGE_START);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_END);

    // Both text deltas must be present and in order
    const textContents = events.filter(
      (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
    ) as { delta: string }[];
    expect(textContents).toHaveLength(2);
    expect(textContents[0].delta).toBe("Hello ");
    expect(textContents[1].delta).toBe("world!");

    // No reasoning signature leaked
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("reasoningSignature");
      expect(serialized).not.toContain("reasoning_signature");
    }
    expect(kinds).not.toContain("reasoningSignatureEvent");

    // Only a single TEXT_MESSAGE_START — the signature did not cause the
    // adapter to close and reopen the message envelope.
    const starts = kinds.filter((k) => k === EventType.TEXT_MESSAGE_START);
    expect(starts).toHaveLength(1);
  });
});

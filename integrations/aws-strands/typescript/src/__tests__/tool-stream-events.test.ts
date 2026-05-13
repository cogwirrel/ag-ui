/**
 * Verifies that mid-execution tool yields arrive as STATE_SNAPSHOT events.
 *
 * The Strands v1 SDK wraps `ToolStreamEvent` (produced by an async-generator
 * tool yielding `{ state: ... }`) inside `ToolStreamUpdateEvent`:
 *
 *   { type: "toolStreamUpdateEvent",
 *     agent, invocationState,
 *     event: { type: "toolStreamEvent", data: { state: { ... } } } }
 *
 * The adapter must unwrap the outer envelope before dispatching; otherwise
 * the inner `kind === "toolStreamEvent"` branch never fires and mid-tool
 * state updates are silently lost.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import { minimalRunInput } from "./helpers";

function scriptedAgent(events: AgentStreamEvent[]) {
  const registry = {
    _tools: new Map<string, unknown>(),
    add(t: unknown): void {
      const tool = t as { name: string };
      this._tools.set(tool.name, t);
    },
    get(name: string) {
      return this._tools.get(name);
    },
    remove(name: unknown) {
      if (typeof name === "string") this._tools.delete(name);
    },
    values() {
      return Array.from(this._tools.values());
    },
  };
  return {
    model: { name: "stub" },
    messages: [] as unknown[],
    tools: [],
    toolRegistry: registry,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
  } as unknown as import("@strands-agents/sdk").Agent;
}

class TestableAgent extends StrandsAgent {
  constructor(
    stub: import("@strands-agents/sdk").Agent,
    config?: StrandsAgentConfig,
  ) {
    super({ agent: stub, name: "t", config });
    (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
  }
}

describe("tool_stream_event handling", () => {
  it("emits STATE_SNAPSHOT for each { state } yielded by an async-generator tool", async () => {
    // Three mid-tool yields, each producing a different `{ state: ... }`
    // payload, exactly as a tool's async generator would.
    const script: AgentStreamEvent[] = [
      {
        type: "toolStreamUpdateEvent",
        event: {
          type: "toolStreamEvent",
          data: { state: { steps: [{ description: "a", status: "pending" }] } },
        },
      } as unknown as AgentStreamEvent,
      {
        type: "toolStreamUpdateEvent",
        event: {
          type: "toolStreamEvent",
          data: {
            state: { steps: [{ description: "a", status: "in_progress" }] },
          },
        },
      } as unknown as AgentStreamEvent,
      {
        type: "toolStreamUpdateEvent",
        event: {
          type: "toolStreamEvent",
          data: {
            state: { steps: [{ description: "a", status: "completed" }] },
          },
        },
      } as unknown as AgentStreamEvent,
    ];

    const agent = new TestableAgent(scriptedAgent(script));
    const events: unknown[] = [];
    for await (const ev of agent.run(minimalRunInput())) events.push(ev);

    const snapshots = events.filter(
      (e) => (e as { type: string }).type === EventType.STATE_SNAPSHOT,
    ) as Array<{ snapshot: { steps?: Array<{ status: string }> } }>;

    // Initial (run start) + 3 mid-tool + final (run end) = 5. We only assert
    // that the three yields produced distinct status transitions, without
    // pinning the exact total so future framing changes don't regress this.
    const statuses = snapshots
      .map((s) => s.snapshot?.steps?.[0]?.status)
      .filter((x): x is string => typeof x === "string");
    expect(statuses).toContain("pending");
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("completed");
  });

  it("ignores toolStreamUpdateEvent whose inner event carries no { state }", async () => {
    // Tools can yield arbitrary progress payloads; only `{ state: ... }`
    // yields should translate into STATE_SNAPSHOT. A yield like
    // `{ progress: 42 }` (or any other non-state shape) should pass through
    // without emitting a spurious empty snapshot.
    const script: AgentStreamEvent[] = [
      {
        type: "toolStreamUpdateEvent",
        event: { type: "toolStreamEvent", data: { progress: 42 } },
      } as unknown as AgentStreamEvent,
      {
        type: "toolStreamUpdateEvent",
        event: { type: "toolStreamEvent", data: "plain string payload" },
      } as unknown as AgentStreamEvent,
    ];

    const agent = new TestableAgent(scriptedAgent(script));
    const events: unknown[] = [];
    for await (const ev of agent.run(minimalRunInput())) events.push(ev);

    // Only the lifecycle snapshots (run-start + run-end) — no extras for the
    // non-state tool yields.
    const snapshots = events.filter(
      (e) => (e as { type: string }).type === EventType.STATE_SNAPSHOT,
    );
    expect(snapshots.length).toBeLessThanOrEqual(2);
  });
});

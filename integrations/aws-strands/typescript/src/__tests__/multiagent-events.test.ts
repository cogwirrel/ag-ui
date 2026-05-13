/**
 * Multi-agent events from the TS Strands SDK must translate to
 * AG-UI STEP_STARTED / STEP_FINISHED / CUSTOM{MultiAgentHandoff}.
 *
 * The TS SDK emits hook-event class instances — see
 * `@strands-agents/sdk/dist/src/multiagent/events.d.ts`:
 *   class BeforeNodeCallEvent   { type: 'beforeNodeCallEvent';   nodeId }
 *   class AfterNodeCallEvent    { type: 'afterNodeCallEvent';    nodeId, nodeType }
 *   class MultiAgentHandoffEvent{ type: 'multiAgentHandoffEvent'; source, targets }
 *
 * The Py adapter emits MultiAgentHandoff CustomEvents with
 * { from_nodes: [...], to_nodes: [...] }. TS converts `source` to a single-
 * element `from_nodes` array to preserve that wire shape for clients that
 * already consume Py events.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import type { AgentStreamEvent } from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

function scriptedAgent(events: unknown[]) {
  const registry = {
    _tools: new Map<string, unknown>(),
    add(t: unknown) {
      this._tools.set((t as { name: string }).name, t);
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
    remove(t: unknown) {
      if (typeof t === "string") this._tools.delete(t);
    },
    values() {
      return Array.from(this._tools.values());
    },
  };
  return {
    model: {},
    tools: [],
    toolRegistry: registry,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
  } as unknown as import("@strands-agents/sdk").Agent;
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

async function drain(agent: StrandsAgent) {
  const out: unknown[] = [];
  for await (const e of agent.run(minimalRunInput())) out.push(e);
  return out;
}

describe("Multi-agent event dispatch", () => {
  it("beforeNodeCallEvent → STEP_STARTED uses nodeType prefix", async () => {
    const stub = scriptedAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "researcher",
        nodeType: "multiAgent",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_STARTED,
    ) as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].stepName).toBe("multiAgent:researcher");
  });

  it("beforeNodeCallEvent without nodeType falls back to 'agent:' prefix", async () => {
    const stub = scriptedAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "researcher",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_STARTED,
    ) as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].stepName).toBe("agent:researcher");
  });

  // Spec (events.mdx §StepFinished): "The stepName must match the corresponding
  // StepStarted event to properly pair the beginning and end of the step."
  // Both START and FINISH must derive their prefix from the same `nodeType`
  // source so the pair stays matchable regardless of nodeType value.
  it("STEP_STARTED and STEP_FINISHED stepNames match when nodeType is set", async () => {
    const stub = scriptedAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "writer",
        nodeType: "multiAgent",
      } as unknown as AgentStreamEvent,
      {
        type: "afterNodeCallEvent",
        nodeId: "writer",
        nodeType: "multiAgent",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_STARTED,
    ) as Array<{ stepName: string }>;
    const stops = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_FINISHED,
    ) as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
    expect(starts[0].stepName).toBe(stops[0].stepName);
  });

  it("afterNodeCallEvent → STEP_FINISHED with nodeType prefix", async () => {
    const stub = scriptedAgent([
      {
        type: "afterNodeCallEvent",
        nodeId: "writer",
        nodeType: "multiAgent",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const stops = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_FINISHED,
    ) as Array<{ stepName: string }>;
    expect(stops).toHaveLength(1);
    expect(stops[0].stepName).toBe("multiAgent:writer");
  });

  it("multiAgentHandoffEvent → CUSTOM{MultiAgentHandoff} with Py-compatible from_nodes/to_nodes", async () => {
    const stub = scriptedAgent([
      {
        type: "multiAgentHandoffEvent",
        source: "researcher",
        targets: ["writer", "editor"],
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const customs = events.filter(
      (e) => (e as { type: string }).type === EventType.CUSTOM,
    ) as Array<{
      name: string;
      value: Record<string, unknown>;
    }>;
    expect(customs).toHaveLength(1);
    expect(customs[0].name).toBe("MultiAgentHandoff");
    expect(customs[0].value).toMatchObject({
      from_nodes: ["researcher"],
      to_nodes: ["writer", "editor"],
    });
  });

  // The Py adapter forwards `message` inside the CustomEvent.value so a frontend
  // consuming either adapter can show the handoff caption.
  it("multiAgentHandoffEvent forwards the message field (Py parity)", async () => {
    const stub = scriptedAgent([
      {
        type: "multiAgentHandoffEvent",
        source: "researcher",
        targets: ["writer"],
        message: "Handing off draft to writer",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const customs = events.filter(
      (e) => (e as { type: string }).type === EventType.CUSTOM,
    ) as Array<{ value: Record<string, unknown> }>;
    expect(customs).toHaveLength(1);
    expect(customs[0].value.message).toBe("Handing off draft to writer");
  });

  it("full multi-node sequence produces paired STEP events and a handoff", async () => {
    const stub = scriptedAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "n1",
      } as unknown as AgentStreamEvent,
      {
        type: "afterNodeCallEvent",
        nodeId: "n1",
        nodeType: "agent",
      } as unknown as AgentStreamEvent,
      {
        type: "multiAgentHandoffEvent",
        source: "n1",
        targets: ["n2"],
      } as unknown as AgentStreamEvent,
      {
        type: "beforeNodeCallEvent",
        nodeId: "n2",
      } as unknown as AgentStreamEvent,
      {
        type: "afterNodeCallEvent",
        nodeId: "n2",
        nodeType: "agent",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_STARTED,
    );
    const stops = events.filter(
      (e) => (e as { type: string }).type === EventType.STEP_FINISHED,
    );
    const customs = events.filter(
      (e) => (e as { type: string }).type === EventType.CUSTOM,
    );
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(customs).toHaveLength(1);
  });

  it("legacy snake_case multiagent_* event names are ignored (TS SDK uses different names)", async () => {
    const stub = scriptedAgent([
      // Neither Py nor TS SDKs yield events in this snake_case shape at
      // the TS SDK boundary. The adapter must not match them and must
      // let them pass through without crashing.
      {
        type: "multiagent_node_start",
        node_id: "x",
        node_type: "agent",
      } as unknown as AgentStreamEvent,
      {
        type: "multiagent_handoff",
        from_node_ids: ["a"],
        to_node_ids: ["b"],
      } as unknown as AgentStreamEvent,
    ]);
    const events = await drain(new Testable(stub));
    // No STEP or MultiAgentHandoff emitted for legacy snake_case.
    expect(
      events.some(
        (e) => (e as { type: string }).type === EventType.STEP_STARTED,
      ),
    ).toBe(false);
    expect(
      events.some(
        (e) =>
          (e as { type: string }).type === EventType.CUSTOM &&
          (e as { name?: string }).name === "MultiAgentHandoff",
      ),
    ).toBe(false);
  });
});

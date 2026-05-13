/**
 * `ToolBehavior.continueAfterFrontendCall = true` must keep the stream
 * alive after a frontend tool call completes. Without the flag, the
 * adapter sets `pendingHalt` after emitting TOOL_CALL_END and silences
 * subsequent events (including any trailing text). With the flag, the
 * adapter must NOT halt — subsequent text deltas should flow through to
 * the client.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType, type RunAgentInput } from "@ag-ui/core";

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

async function drain(agent: StrandsAgent, input: RunAgentInput) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

function frontendToolInput(): RunAgentInput {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "do a thing" }],
    tools: [
      {
        name: "set_color",
        description: "Sets a UI color.",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } },
          required: ["color"],
        },
      },
    ],
  });
}

/**
 * Realistic Strands stream shape for a frontend tool call:
 *   1. ToolUseBlock emitted for `set_color`
 *   2. afterToolCallEvent fires with Strands' placeholder proxy result
 *      ("Forwarded to client") — this is the signal that flips
 *      pendingHalt → haltEventStream when the flag is off.
 *   3. A text delta Strands would stream after the tool — should be
 *      suppressed in default halt mode, passed through with continue flag.
 */
const scriptedEvents: AgentStreamEvent[] = [
  new ToolUseBlock({
    name: "set_color",
    toolUseId: "fe-1",
    input: { color: "red" },
  }) as unknown as AgentStreamEvent,
  {
    type: "afterToolCallEvent",
    toolUse: { toolUseId: "fe-1", name: "set_color", input: { color: "red" } },
    tool: undefined,
    result: {
      toolUseId: "fe-1",
      status: "success",
      content: [{ text: "Forwarded to client" }],
    },
  } as unknown as AgentStreamEvent,
  {
    type: "modelContentBlockDeltaEvent",
    delta: { type: "textDelta", text: "after-tool" },
  } as unknown as AgentStreamEvent,
  { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
];

describe("continueAfterFrontendCall", () => {
  it("default (halt): trailing text after a frontend tool call is suppressed", async () => {
    const agent = new Testable(scriptedAgent(scriptedEvents));
    // No override — default is halt after frontend tool call.
    const events = await drain(agent, frontendToolInput());
    const k = events.map((e) => (e as { type: string }).type);
    expect(k).toContain(EventType.TOOL_CALL_START);
    expect(k).toContain(EventType.TOOL_CALL_END);
    // Trailing text MUST NOT reach the client.
    const content = events
      .filter(
        (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
      )
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(content).not.toContain("after-tool");
  });

  it("continueAfterFrontendCall=true: trailing text IS delivered to the client", async () => {
    const agent = new Testable(scriptedAgent(scriptedEvents));
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_color: { continueAfterFrontendCall: true },
      },
    };
    const events = await drain(agent, frontendToolInput());
    const k = events.map((e) => (e as { type: string }).type);
    expect(k).toContain(EventType.TOOL_CALL_END);
    const content = events
      .filter(
        (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
      )
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(content).toContain("after-tool");
  });

  it("swallows 'Stream ended without completing a message' when halting from a frontend tool call", async () => {
    // Strands v1.0+ raises when the agent loop halts before a final
    // assistant message is produced. Our adapter should treat that as a
    // clean end-of-stream (not RUN_ERROR) as long as we've already
    // decided to halt because of a frontend tool call.
    function throwingStream(events: AgentStreamEvent[]) {
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
        remove() {},
        values() {
          return Array.from(this._tools.values());
        },
      };
      return {
        model: {},
        tools: [],
        toolRegistry: registry,
        async *stream() {
          for (const e of events) yield e;
          throw new Error("Stream ended without completing a message");
        },
      } as unknown as import("@strands-agents/sdk").Agent;
    }
    const block = new ToolUseBlock({
      name: "set_color",
      toolUseId: "fe-99",
      input: { color: "red" },
    });
    const agent = new Testable(
      throwingStream([
        block as unknown as AgentStreamEvent,
        // afterToolCallEvent fires before the throw, flipping pendingHalt.
        {
          type: "afterToolCallEvent",
          toolUse: {
            toolUseId: "fe-99",
            name: "set_color",
            input: { color: "red" },
          },
          tool: undefined,
          result: {
            toolUseId: "fe-99",
            status: "success",
            content: [{ text: "Forwarded to client" }],
          },
        } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await drain(agent, frontendToolInput());
    const k = events.map((e) => (e as { type: string }).type);
    expect(k).toContain(EventType.TOOL_CALL_END);
    expect(k).not.toContain(EventType.RUN_ERROR);
    expect(k[k.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("continueAfterFrontendCall=true still skips TOOL_CALL_RESULT for frontend tools", async () => {
    // Even when we don't halt, the frontend tool's placeholder result from
    // the Strands proxy must not be emitted — the real result comes from
    // the client on the next run.
    const events: AgentStreamEvent[] = [
      new ToolUseBlock({
        name: "set_color",
        toolUseId: "fe-2",
        input: { color: "blue" },
      }) as unknown as AgentStreamEvent,
      // afterToolCallEvent for the frontend tool — Strands' proxy produces
      // a placeholder "Forwarded to client" result that must be suppressed.
      {
        type: "afterToolCallEvent",
        toolUse: {
          toolUseId: "fe-2",
          name: "set_color",
          input: { color: "blue" },
        },
        tool: undefined,
        result: {
          toolUseId: "fe-2",
          status: "success",
          content: [{ text: "Forwarded to client" }],
        },
      } as unknown as AgentStreamEvent,
    ];
    const agent = new Testable(scriptedAgent(events));
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_color: { continueAfterFrontendCall: true },
      },
    };
    const collected = await drain(agent, frontendToolInput());
    const k = collected.map((e) => (e as { type: string }).type);
    expect(k).not.toContain(EventType.TOOL_CALL_RESULT);
    expect(k).toContain(EventType.TOOL_CALL_END);
  });

  it("DOES surface RUN_ERROR when the stream throws WITHOUT a prior halt signal", async () => {
    // Tightness check: the stream-end swallow added for frontend-halt
    // parity (agent.ts `if (pendingHalt || haltEventStream)`) must NOT
    // mask real model failures. Stream throws outside a halt context →
    // RUN_ERROR must flow back to the client.
    function alwaysThrowingAgent(): import("@strands-agents/sdk").Agent {
      return {
        model: {},
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
        async *stream() {
          throw new Error("Bedrock upstream 500: internal server error");
        },
      } as unknown as import("@strands-agents/sdk").Agent;
    }
    const agent = new Testable(alwaysThrowingAgent());
    const events = await drain(agent, minimalRunInput());
    const k = events.map((e) => (e as { type: string }).type);
    const err = events.find(
      (e) => (e as { type: string }).type === EventType.RUN_ERROR,
    ) as (BaseEvent & { code?: string; message?: string }) | undefined;
    expect(err).toBeDefined();
    expect(err?.code).toBe("STRANDS_ERROR");
    expect(err?.message).toContain("Bedrock upstream 500");
    // And no false RUN_FINISHED — the error is the terminator.
    expect(k[k.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("surfaces RUN_ERROR when the stream throws with the Strands 'Stream ended' message but no pending halt", async () => {
    // Also make sure we're not doing a naive string match on the error
    // message — the swallow must only fire when the halt flags are set,
    // regardless of what the thrown message says.
    function throwingAgent(): import("@strands-agents/sdk").Agent {
      return {
        model: {},
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
        async *stream() {
          // Same error text that triggers the halt-swallow in the earlier
          // test, but this time no frontend tool call / no halt flag.
          throw new Error("Stream ended without completing a message");
        },
      } as unknown as import("@strands-agents/sdk").Agent;
    }
    const agent = new Testable(throwingAgent());
    // No frontend tools advertised — adapter has no reason to halt.
    const events = await drain(agent, minimalRunInput());
    const err = events.find(
      (e) => (e as { type: string }).type === EventType.RUN_ERROR,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("STRANDS_ERROR");
  });
});

type BaseEvent = { type: string } & Record<string, unknown>;

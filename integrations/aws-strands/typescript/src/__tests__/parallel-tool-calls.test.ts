/**
 * Tests for parallel frontend tool-call handling in StrandsAgent.
 *
 * Port of Python's test_parallel_tool_call_handling.py.
 *
 * Scenario A – Multiple parallel frontend tool calls must all be emitted.
 * Scenario B – New tool calls must not be suppressed by a pending tool result
 *              on continuation turns.
 * Scenario C – Backend tool results must not leak after halt flag is set.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";

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
      if (typeof name === "string") this._tools.delete(name);
      else {
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
    _systemPrompt: undefined,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
  } as unknown as import("@strands-agents/sdk").Agent;
}

class TestableStrandsAgent extends StrandsAgent {
  constructor(
    stub: import("@strands-agents/sdk").Agent,
    config?: StrandsAgentConfig,
  ) {
    super({ agent: stub, name: "test", config });
    const byThread = (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set("thread-1", stub);
    byThread.set("default", stub);
  }
}

async function collect(input: RunAgentInput, agent: StrandsAgent) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Scenario A – All parallel frontend tool calls must be emitted
// ---------------------------------------------------------------------------

describe("Parallel frontend tool calls — all emitted", () => {
  const TOOLS = [
    { name: "frontend_a", description: "a", parameters: {} },
    { name: "frontend_b", description: "b", parameters: {} },
  ];

  it("both tool calls are emitted via ToolUseBlock path", async () => {
    const blockA = new ToolUseBlock({
      name: "frontend_a",
      toolUseId: "st-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "frontend_b",
      toolUseId: "st-b",
      input: {},
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        blockA as unknown as AgentStreamEvent,
        blockB as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput({ tools: TOOLS }), agent);
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    ) as { toolCallName: string }[];
    const names = new Set(starts.map((s) => s.toolCallName));
    expect(names.has("frontend_a")).toBe(true);
    expect(names.has("frontend_b")).toBe(true);
    expect(starts).toHaveLength(2);
  });

  it("both tool calls are emitted via streaming contentBlockStop path", async () => {
    const events: AgentStreamEvent[] = [
      {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "frontend_a", toolUseId: "st-a" },
      } as unknown as AgentStreamEvent,
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: "{}" },
      } as unknown as AgentStreamEvent,
      { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
      {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "frontend_b", toolUseId: "st-b" },
      } as unknown as AgentStreamEvent,
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: "{}" },
      } as unknown as AgentStreamEvent,
      { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
    ];
    const agent = new TestableStrandsAgent(scriptedAgent(events));
    const result = await collect(minimalRunInput({ tools: TOOLS }), agent);
    const starts = result.filter(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    ) as { toolCallName: string }[];
    const names = new Set(starts.map((s) => s.toolCallName));
    expect(names.has("frontend_a")).toBe(true);
    expect(names.has("frontend_b")).toBe(true);
    expect(starts).toHaveLength(2);
  });

  it("every TOOL_CALL_START has a matching TOOL_CALL_END", async () => {
    const blockA = new ToolUseBlock({
      name: "frontend_a",
      toolUseId: "st-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "frontend_b",
      toolUseId: "st-b",
      input: {},
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        blockA as unknown as AgentStreamEvent,
        blockB as unknown as AgentStreamEvent,
      ]),
    );
    const result = await collect(minimalRunInput({ tools: TOOLS }), agent);
    const startIds = new Set(
      (
        result.filter(
          (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
        ) as {
          toolCallId: string;
        }[]
      ).map((e) => e.toolCallId),
    );
    const endIds = new Set(
      (
        result.filter(
          (e) => (e as { type: string }).type === EventType.TOOL_CALL_END,
        ) as {
          toolCallId: string;
        }[]
      ).map((e) => e.toolCallId),
    );
    expect(startIds).toEqual(endIds);
    expect(startIds.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario B – New tool calls must not be suppressed by pending tool result
// ---------------------------------------------------------------------------

describe("Continuation turn emits new tool calls", () => {
  const TOOLS = [{ name: "frontend_tool", description: "d", parameters: {} }];

  function continuationMessages() {
    return [
      { id: "u1", role: "user" as const, content: "do something" },
      {
        id: "a1",
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "prev-tc",
            type: "function" as const,
            function: { name: "frontend_tool", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool" as const,
        content: "done",
        toolCallId: "prev-tc",
      },
    ];
  }

  it("new tool call ID is emitted on continuation", async () => {
    const block = new ToolUseBlock({
      name: "frontend_tool",
      toolUseId: "st-new",
      input: { x: 1 },
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([block as unknown as AgentStreamEvent]),
    );
    const events = await collect(
      minimalRunInput({ messages: continuationMessages(), tools: TOOLS }),
      agent,
    );
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    ) as { toolCallName: string }[];
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallName).toBe("frontend_tool");
  });

  it("already-resolved backend tool call is suppressed", async () => {
    const messages = [
      { id: "u1", role: "user" as const, content: "do something" },
      {
        id: "a1",
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "prev-tc",
            type: "function" as const,
            function: { name: "backend_tool", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool" as const,
        content: "result",
        toolCallId: "prev-tc",
      },
    ];
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "prev-tc",
      input: {},
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([block as unknown as AgentStreamEvent]),
    );
    const events = await collect(
      minimalRunInput({ messages, tools: [] }),
      agent,
    );
    const starts = events.filter(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    );
    expect(starts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario C – No backend tool results must leak after halt
// ---------------------------------------------------------------------------

describe("No backend result leak after halt", () => {
  it("only the halting result is emitted", async () => {
    const config: StrandsAgentConfig = {
      toolBehaviors: {
        backend_halt_tool: { stopStreamingAfterResult: true },
      },
    };
    const block1 = new ToolUseBlock({
      name: "backend_halt_tool",
      toolUseId: "st1",
      input: {},
    });
    const block2 = new ToolUseBlock({
      name: "backend_other",
      toolUseId: "st2",
      input: {},
    });
    const result1 = new ToolResultBlock({
      toolUseId: "st1",
      status: "success",
      content: [new TextBlock(JSON.stringify({ value: 1 }))],
    });
    const result2 = new ToolResultBlock({
      toolUseId: "st2",
      status: "success",
      content: [new TextBlock(JSON.stringify({ value: 2 }))],
    });

    const events: AgentStreamEvent[] = [
      block1 as unknown as AgentStreamEvent,
      block2 as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "st1", name: "backend_halt_tool", input: {} },
        result: result1,
      } as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "st2", name: "backend_other", input: {} },
        result: result2,
      } as unknown as AgentStreamEvent,
    ];

    const agent = new TestableStrandsAgent(scriptedAgent(events), config);
    const result = await collect(minimalRunInput(), agent);
    const resultEvents = result.filter(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_RESULT,
    ) as { toolCallId: string }[];
    const resultIds = resultEvents.map((e) => e.toolCallId);

    expect(resultIds).toContain("st1");
    expect(resultIds).not.toContain("st2");
    expect(resultEvents).toHaveLength(1);
  });
});

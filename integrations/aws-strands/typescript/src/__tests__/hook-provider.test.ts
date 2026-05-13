/**
 * Tests for hook provider independence across threads.
 *
 * Port of Python's test_template_hooks_preservation.py — validates that
 * per-thread agents receive independent hook/config state.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig, ToolResultContext } from "../config";
import { minimalRunInput } from "./helpers";

function scriptedAgent(events: AgentStreamEvent[] = []) {
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
    remove(name: unknown) {
      if (typeof name === "string") this._tools.delete(name);
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

async function collect(input: RunAgentInput, agent: StrandsAgent) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

class TestableStrandsAgent extends StrandsAgent {
  constructor(
    stub: import("@strands-agents/sdk").Agent,
    config?: StrandsAgentConfig,
  ) {
    super({ agent: stub, name: "test", config });
  }

  injectThread(threadId: string, stub: import("@strands-agents/sdk").Agent) {
    const byThread = (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set(threadId, stub);
  }
}

describe("Hook provider — stateFromResult independence across threads", () => {
  it("stateFromResult fires independently per thread", async () => {
    const callLog: { threadId: string; result: unknown }[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        my_tool: {
          stateFromResult: (ctx: ToolResultContext) => {
            callLog.push({
              threadId: ctx.inputData.threadId!,
              result: ctx.resultData,
            });
            return { counter: callLog.length };
          },
        },
      },
    };

    const makeEvents = (resultValue: unknown): AgentStreamEvent[] => {
      const block = new ToolUseBlock({
        name: "my_tool",
        toolUseId: "t1",
        input: {},
      });
      const result = new ToolResultBlock({
        toolUseId: "t1",
        status: "success",
        content: [new TextBlock(JSON.stringify(resultValue))],
      });
      return [
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: { toolUseId: "t1", name: "my_tool", input: {} },
          result,
        } as unknown as AgentStreamEvent,
      ];
    };

    const agent = new TestableStrandsAgent(scriptedAgent(), config);
    agent.injectThread("thread-A", scriptedAgent(makeEvents({ x: 1 })));
    agent.injectThread("thread-B", scriptedAgent(makeEvents({ x: 2 })));

    await collect(minimalRunInput({ threadId: "thread-A" }), agent);
    await collect(minimalRunInput({ threadId: "thread-B" }), agent);

    expect(callLog).toHaveLength(2);
    expect(callLog[0].threadId).toBe("thread-A");
    expect(callLog[0].result).toEqual({ x: 1 });
    expect(callLog[1].threadId).toBe("thread-B");
    expect(callLog[1].result).toEqual({ x: 2 });
  });

  it("customResultHandler fires independently per thread", async () => {
    const handlerLog: string[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        my_tool: {
          async *customResultHandler(ctx: ToolResultContext) {
            handlerLog.push(ctx.inputData.threadId!);
            yield {
              type: EventType.CUSTOM,
              name: "Hook",
              value: ctx.inputData.threadId,
            };
          },
        },
      },
    };

    const makeEvents = (): AgentStreamEvent[] => {
      const block = new ToolUseBlock({
        name: "my_tool",
        toolUseId: "t1",
        input: {},
      });
      const result = new ToolResultBlock({
        toolUseId: "t1",
        status: "success",
        content: [new TextBlock('"ok"')],
      });
      return [
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: { toolUseId: "t1", name: "my_tool", input: {} },
          result,
        } as unknown as AgentStreamEvent,
      ];
    };

    const agent = new TestableStrandsAgent(scriptedAgent(), config);
    agent.injectThread("thread-X", scriptedAgent(makeEvents()));
    agent.injectThread("thread-Y", scriptedAgent(makeEvents()));

    const eventsX = await collect(
      minimalRunInput({ threadId: "thread-X" }),
      agent,
    );
    const eventsY = await collect(
      minimalRunInput({ threadId: "thread-Y" }),
      agent,
    );

    expect(handlerLog).toEqual(["thread-X", "thread-Y"]);

    const customX = eventsX.find(
      (e) =>
        (e as { type: string }).type === EventType.CUSTOM &&
        (e as { name: string }).name === "Hook",
    ) as { value: string };
    const customY = eventsY.find(
      (e) =>
        (e as { type: string }).type === EventType.CUSTOM &&
        (e as { name: string }).name === "Hook",
    ) as { value: string };

    expect(customX.value).toBe("thread-X");
    expect(customY.value).toBe("thread-Y");
  });
});

describe("Hook provider — argsStreamer per-tool isolation", () => {
  it("argsStreamer fires only for the configured tool", async () => {
    const streamerLog: string[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        streamed_tool: {
          async *argsStreamer(ctx) {
            streamerLog.push(ctx.toolName);
            yield '{"partial":';
            yield '"value"}';
          },
        },
      },
    };

    const block1 = new ToolUseBlock({
      name: "streamed_tool",
      toolUseId: "s1",
      input: { partial: "value" },
    });
    const block2 = new ToolUseBlock({
      name: "other_tool",
      toolUseId: "s2",
      input: { foo: 1 },
    });

    const agent = new TestableStrandsAgent(
      scriptedAgent([
        block1 as unknown as AgentStreamEvent,
        block2 as unknown as AgentStreamEvent,
      ]),
      config,
    );
    const byThread = (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set(
      "thread-1",
      scriptedAgent([
        block1 as unknown as AgentStreamEvent,
        block2 as unknown as AgentStreamEvent,
      ]),
    );

    const events = await collect(minimalRunInput(), agent);
    expect(streamerLog).toEqual(["streamed_tool"]);

    // streamed_tool should have 2 TOOL_CALL_ARGS events (from the streamer)
    const argsEvents = events.filter(
      (e) =>
        (e as { type: string }).type === EventType.TOOL_CALL_ARGS &&
        (e as { toolCallId: string }).toolCallId === "s1",
    );
    expect(argsEvents).toHaveLength(2);

    // other_tool should have 1 TOOL_CALL_ARGS event (default full args)
    const otherArgs = events.filter(
      (e) =>
        (e as { type: string }).type === EventType.TOOL_CALL_ARGS &&
        (e as { toolCallId: string }).toolCallId === "s2",
    );
    expect(otherArgs).toHaveLength(1);
  });
});

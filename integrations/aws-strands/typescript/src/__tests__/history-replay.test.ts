/**
 * History reconciliation (replayHistoryIntoStrands). Fixes the "chart loops
 * forever" symptom: without replay, the LLM never sees the client-produced
 * tool result on the next turn and re-fires the same tool.
 *
 * Python parity: adapter mirrors agent.py's _build_strands_history and
 * stream_async(None) flow.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import type { RunAgentInput } from "@ag-ui/core";
import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import { minimalRunInput } from "./helpers";

function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = {
    model: {},
    messages: [] as unknown[],
    tools: [],
    sessionManager: undefined,
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
  } as unknown as import("@strands-agents/sdk").Agent & {
    messages: unknown[];
    sessionManager: unknown;
  };
  return { stub, calls };
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
    (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("default", stub);
  }
}

async function drain(agent: StrandsAgent, input: RunAgentInput) {
  for await (const _ of agent.run(input)) {
    // intentionally discard
  }
}

describe("replayHistoryIntoStrands", () => {
  it("rebuilds agent.messages before stream() and calls stream(undefined)", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new TestableAgent(stub);
    await drain(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "hi" },
          { id: "u2", role: "user", content: "another" },
        ],
      }),
    );
    expect(calls).toHaveLength(1);
    // stream(undefined) is the signal to Strands: "use my this.messages as-is".
    expect(calls[0]!.args).toBeUndefined();
    expect(calls[0]!.messages).toHaveLength(3);
  });

  it("renders prior tool_calls as toolUse ContentBlocks so the LLM sees them", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new TestableAgent(stub);
    await drain(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: '{"x":1}' },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    // 3 turns: user, assistant(toolUse), user(toolResult)
    expect(history).toHaveLength(3);
    expect(history[1]!.role).toBe("assistant");
    // Message.fromMessageData converts plain { toolUse: {...} } objects to
    // ToolUseBlock instances — inspect fields on the instance directly.
    const toolUseBlock = history[1]!.content[0] as {
      type: string;
      toolUseId: string;
      name: string;
    };
    expect(toolUseBlock.type).toBe("toolUseBlock");
    expect(toolUseBlock.toolUseId).toBe("tc1");
    expect(toolUseBlock.name).toBe("render_chart");
    expect(history[2]!.role).toBe("user");
    expect((history[2]!.content[0] as { type: string }).type).toBe(
      "toolResultBlock",
    );
  });

  it("is disabled when replayHistoryIntoStrands=false", async () => {
    const { stub, calls } = recordingAgent();
    const agent = new TestableAgent(stub, { replayHistoryIntoStrands: false });
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    // Falls back to the legacy path: stream("hello"), agent.messages empty.
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });

  it("is disabled when the agent has a session manager (Strands owns history)", async () => {
    const { stub, calls } = recordingAgent();
    (stub as { sessionManager: unknown }).sessionManager = {
      // presence is enough — adapter only checks truthiness
    };
    const agent = new TestableAgent(stub);
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });
});

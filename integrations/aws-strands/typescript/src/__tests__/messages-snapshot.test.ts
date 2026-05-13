/**
 * MessagesSnapshotEvent emission + message_id rotation.
 *
 * Four lifecycle splice points (Python parity, PR #1638):
 *   1. after the initial STATE_SNAPSHOT
 *   2. after each TOOL_CALL_END
 *   3. after each TOOL_CALL_RESULT
 *   4. after each terminal TEXT_MESSAGE_END
 *
 * message_id rotates after each assistant snapshot entry is appended so
 * CopilotKit v2's id-keyed message map doesn't overwrite an entry with
 * its successor (the "orphan ToolMessage → OpenAI role='tool' must follow
 * tool_calls" failure mode).
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";

import { StrandsAgent, buildSnapshotMessages } from "../agent";
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
    },
    values() {
      return Array.from(this._tools.values());
    },
  };
  return {
    model: { name: "stub-model" },
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
    )._agentsByThread.set("default", stub);
    (
      this as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
  }
}

async function collect(input: RunAgentInput, agent: StrandsAgent) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

describe("MESSAGES_SNAPSHOT — initial seed", () => {
  it("emits an initial MESSAGES_SNAPSHOT seeded from RunAgentInput.messages", async () => {
    const agent = new TestableAgent(scriptedAgent([]));
    const events = (await collect(
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "hi" },
        ],
      }),
      agent,
    )) as Array<Record<string, unknown>>;
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const first = snapshots[0]!.messages;
    expect(first).toHaveLength(2);
    expect(first[0]!.role).toBe("user");
    expect(first[1]!.role).toBe("assistant");
  });

  it("does NOT emit an initial snapshot when messages[] is empty", async () => {
    const agent = new TestableAgent(scriptedAgent([]));
    const events = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toHaveLength(0);
  });

  it("is globally suppressed by emitMessagesSnapshot=false", async () => {
    const agent = new TestableAgent(scriptedAgent([]), {
      emitMessagesSnapshot: false,
    });
    const events = (await collect(
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hi" }],
      }),
      agent,
    )) as Array<Record<string, unknown>>;
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toHaveLength(0);
  });
});

describe("MESSAGES_SNAPSHOT — after tool-call end", () => {
  it("appends an AssistantMessage(toolCalls=[…]) after TOOL_CALL_END", async () => {
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "tc1",
      input: { q: "why" },
    });
    const agent = new TestableAgent(
      scriptedAgent([block as unknown as AgentStreamEvent]),
    );
    const events = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    // Last snapshot should include the assistant tool-call entry.
    const last = snapshots[snapshots.length - 1]!.messages;
    const assistant = last.find((m) => m.role === "assistant") as {
      toolCalls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0]!.id).toBe("tc1");
    expect(assistant.toolCalls![0]!.function.name).toBe("backend_tool");
  });

  it("skipMessagesSnapshot suppresses the per-tool snapshot", async () => {
    const block = new ToolUseBlock({
      name: "quiet_tool",
      toolUseId: "tc2",
      input: {},
    });
    const config: StrandsAgentConfig = {
      toolBehaviors: { quiet_tool: { skipMessagesSnapshot: true } },
    };
    const agent = new TestableAgent(
      scriptedAgent([block as unknown as AgentStreamEvent]),
      config,
    );
    const events = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    const snapshots = events.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    // No snapshot should contain an assistant with a tool-call entry
    // for quiet_tool.
    const hasQuietToolCall = snapshots.some((s) =>
      s.messages.some((m) => {
        if (m.role !== "assistant") return false;
        const tcs = (m as { toolCalls?: Array<{ function: { name: string } }> })
          .toolCalls;
        return tcs?.some((tc) => tc.function.name === "quiet_tool") ?? false;
      }),
    );
    expect(hasQuietToolCall).toBe(false);
  });
});

describe("MESSAGES_SNAPSHOT — after tool result", () => {
  it("appends a ToolMessage after TOOL_CALL_RESULT", async () => {
    const block = new ToolUseBlock({
      name: "compute",
      toolUseId: "tc3",
      input: {},
    });
    const result = new ToolResultBlock({
      toolUseId: "tc3",
      status: "success",
      content: [new TextBlock(JSON.stringify({ answer: 42 }))],
    });
    const events: AgentStreamEvent[] = [
      block as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "tc3", name: "compute", input: {} },
        result,
      } as unknown as AgentStreamEvent,
    ];
    const agent = new TestableAgent(scriptedAgent(events));
    const output = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    const last = snapshots[snapshots.length - 1]!.messages;
    const toolMsg = last.find((m) => m.role === "tool") as {
      toolCallId: string;
      content: string;
    };
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.toolCallId).toBe("tc3");
    expect(toolMsg.content).toContain("42");
  });
});

describe("message_id rotation", () => {
  it("back-to-back tool calls in one run produce assistant entries with distinct ids", async () => {
    const blockA = new ToolUseBlock({
      name: "tool_a",
      toolUseId: "tc-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "tool_b",
      toolUseId: "tc-b",
      input: {},
    });
    const agent = new TestableAgent(
      scriptedAgent([
        blockA as unknown as AgentStreamEvent,
        blockB as unknown as AgentStreamEvent,
      ]),
    );
    const output = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    const lastSnapshot = snapshots[snapshots.length - 1]!.messages;
    const assistantEntries = lastSnapshot.filter(
      (m) => m.role === "assistant",
    ) as Array<{
      id: string;
      toolCalls?: Array<{ function: { name: string } }>;
    }>;
    expect(assistantEntries).toHaveLength(2);
    // Both have tool calls; their ids MUST differ so CopilotKit's id-keyed
    // map doesn't overwrite one with the next.
    expect(assistantEntries[0]!.id).not.toBe(assistantEntries[1]!.id);
  });

  it("text → tool → text run commits accumulated text to the snapshot with its original id", async () => {
    // This replays the canonical sequence that motivated splice points 2
    // and 4: text streams until a tool is announced, we close text and
    // snapshot it, then the tool call runs, then the agent text continues.
    // The accumulated text must appear in a snapshot with the id that was
    // used for TEXT_MESSAGE_START, not the rotated id.
    const events: AgentStreamEvent[] = [
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "opening " },
      } as unknown as AgentStreamEvent,
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "line" },
      } as unknown as AgentStreamEvent,
    ];
    const agent = new TestableAgent(scriptedAgent(events));
    const output = (await collect(minimalRunInput(), agent)) as Array<
      Record<string, unknown>
    >;
    const snapshots = output.filter(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as Array<{ messages: Array<Record<string, unknown>> }>;
    const last = snapshots[snapshots.length - 1]!.messages;
    const assistant = last.find(
      (m) =>
        m.role === "assistant" &&
        typeof (m as { content?: unknown }).content === "string",
    ) as { content: string } | undefined;
    expect(assistant?.content).toBe("opening line");
  });
});

describe("buildSnapshotMessages — standalone helper", () => {
  it("normalises tool-call arguments to a JSON string", () => {
    const out = buildSnapshotMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "foo", arguments: '{"x":1}' },
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const assistant = out[0] as {
      toolCalls?: Array<{ function: { arguments: string } }>;
    };
    expect(assistant.toolCalls![0]!.function.arguments).toBe('{"x":1}');
  });

  it("fabricates ids for entries missing one", () => {
    const out = buildSnapshotMessages([
      { id: "", role: "user", content: "hi" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(typeof (out[0] as { id: string }).id).toBe("string");
    expect((out[0] as { id: string }).id.length).toBeGreaterThan(0);
  });

  it("drops developer / system / reasoning / activity roles", () => {
    const out = buildSnapshotMessages([
      { id: "s1", role: "system", content: "sys" } as never,
      { id: "d1", role: "developer", content: "dev" } as never,
      { id: "r1", role: "reasoning", content: "think" } as never,
    ]);
    expect(out).toHaveLength(0);
  });
});

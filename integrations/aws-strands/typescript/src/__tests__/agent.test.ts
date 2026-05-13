/**
 * Unit tests for StrandsAgent.
 *
 * We don't spin up a full Strands Agent — instead we inject a stub that
 * yields a scripted sequence of events whose `type` discriminators match
 * what `@strands-agents/sdk`'s `Agent.stream()` produces. This keeps tests
 * fast and hermetic and avoids needing a model provider.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, ToolResultBlock, TextBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import type { RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

/**
 * Build a stub Strands Agent that plays a scripted sequence of
 * `AgentStreamEvent` objects. The adapter touches only `.stream()`,
 * `.model`, `.tools`, `.toolRegistry`, so we stub just those.
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
  const stub = {
    model: { name: "stub-model" },
    tools: [],
    toolRegistry: registry,
    _systemPrompt: undefined,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
  };
  return stub as unknown as import("@strands-agents/sdk").Agent;
}

/**
 * Bypass `new Agent()` in the adapter's per-thread init path by
 * pre-populating the cache with our stub. The underlying private field
 * name is stable across SDK versions since we control it.
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

async function collect(input: RunAgentInput, agent: StrandsAgent) {
  const out: unknown[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

function types(events: unknown[]): string[] {
  return events.map((e) => (e as { type: string }).type);
}

describe("StrandsAgent.run — lifecycle", () => {
  it("emits RUN_STARTED + STATE_SNAPSHOT(s) + RUN_FINISHED for an empty stream", async () => {
    const agent = new TestableStrandsAgent(scriptedAgent([]));
    const events = await collect(minimalRunInput(), agent);
    // Initial snapshot is always emitted when state is provided (even {}),
    // plus the final snapshot before RUN_FINISHED. This matches Python's
    // behavior so a client that wires the initial snapshot's state onto
    // its UI doesn't diverge if the server later updates the state.
    const kinds = types(events);
    expect(kinds[0]).toBe(EventType.RUN_STARTED);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(
      kinds.filter((k) => k === EventType.STATE_SNAPSHOT).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("filters `messages` out of the INITIAL state snapshot but keeps it in the FINAL (Py parity)", async () => {
    const agent = new TestableStrandsAgent(scriptedAgent([]));
    const input = minimalRunInput({
      state: { foo: "bar", messages: [{ role: "user", content: "x" }] },
    });
    const events = await collect(input, agent);
    const stateEvents = events.filter(
      (e) => (e as { type: string }).type === EventType.STATE_SNAPSHOT,
    );
    expect(stateEvents).toHaveLength(2);
    // Initial snapshot filters `messages` (frontend doesn't recognize role="tool").
    const initial = (stateEvents[0] as { snapshot: Record<string, unknown> })
      .snapshot;
    expect(initial).not.toHaveProperty("messages");
    expect(initial).toHaveProperty("foo", "bar");
    // Final snapshot preserves `messages` verbatim — matches Py adapter.
    const final = (stateEvents[1] as { snapshot: Record<string, unknown> })
      .snapshot;
    expect(final).toHaveProperty("messages");
    expect(final).toHaveProperty("foo", "bar");
  });

  it("emits RUN_ERROR with STRANDS_ERROR code when the stream throws", async () => {
    const stub = {
      model: {},
      tools: [],
      toolRegistry: {
        values: () => [],
        add() {},
        getByName: () => undefined,
        removeByName() {},
      },
      async *stream() {
        throw new Error("boom");
      },
    } as unknown as import("@strands-agents/sdk").Agent;
    const agent = new TestableStrandsAgent(stub);
    const events = await collect(minimalRunInput(), agent);
    const last = events[events.length - 1] as {
      type: string;
      code: string;
      message: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("STRANDS_ERROR");
    expect(last.message).toBe("boom");
  });
});

describe("StrandsAgent.run — text streaming", () => {
  it("wraps text deltas in TEXT_MESSAGE_START/_CONTENT/_END", async () => {
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "Hello" },
        } as unknown as AgentStreamEvent,
        { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput(), agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_START);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_END);
    const content = events.find(
      (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
    ) as { delta: string };
    expect(content.delta).toBe("Hello");
  });

  it("unwraps Strands v1.0 ModelStreamUpdateEvent wrappers", async () => {
    // Real Strands v1.x yields hook-event wrappers that carry the inner
    // ModelStreamEvent on `.event`. The adapter unwraps these before
    // dispatching so the same codepath handles both wrapped and raw events.
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelStreamUpdateEvent",
          event: {
            type: "modelContentBlockDeltaEvent",
            delta: { type: "textDelta", text: "wrapped" },
          },
        } as unknown as AgentStreamEvent,
        {
          type: "modelStreamUpdateEvent",
          event: { type: "modelContentBlockStopEvent" },
        } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput(), agent);
    const content = events.find(
      (e) => (e as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT,
    ) as { delta: string };
    expect(content).toBeDefined();
    expect(content.delta).toBe("wrapped");
  });
});

describe("StrandsAgent.run — tool calls", () => {
  it("unwraps ContentBlockEvent wrappers around ToolUseBlock", async () => {
    // Strands v1.0 wraps completed content blocks in `ContentBlockEvent`
    // hook events. The adapter unwraps those so the same code path handles
    // both wrapped and raw ToolUseBlock values.
    const block = new ToolUseBlock({
      name: "get_weather",
      toolUseId: "strands-2",
      input: { city: "Seattle" },
    });
    const wrapped = {
      type: "contentBlockEvent",
      contentBlock: block,
    } as unknown as AgentStreamEvent;
    const agent = new TestableStrandsAgent(scriptedAgent([wrapped]));
    const events = await collect(minimalRunInput(), agent);
    const start = events.find(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    ) as { toolCallName: string; toolCallId: string };
    expect(start).toBeDefined();
    expect(start.toolCallName).toBe("get_weather");
    expect(start.toolCallId).toBe("strands-2");
  });

  it("emits TOOL_CALL_START/ARGS/END when a ToolUseBlock is yielded directly", async () => {
    const block = new ToolUseBlock({
      name: "get_weather",
      toolUseId: "strands-1",
      input: { city: "Portland" },
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([block as unknown as AgentStreamEvent]),
    );
    const events = await collect(minimalRunInput(), agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.TOOL_CALL_START);
    expect(kinds).toContain(EventType.TOOL_CALL_ARGS);
    expect(kinds).toContain(EventType.TOOL_CALL_END);

    const start = events.find(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_START,
    ) as { toolCallName: string; toolCallId: string };
    expect(start.toolCallName).toBe("get_weather");
    expect(start.toolCallId).toBe("strands-1");

    const args = events.find(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_ARGS,
    ) as { delta: string };
    expect(JSON.parse(args.delta)).toEqual({ city: "Portland" });
  });

  it("emits TOOL_CALL_RESULT for backend tool results (afterToolCallEvent)", async () => {
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "backend-1",
      input: { x: 1 },
    });
    const resultBlock = new ToolResultBlock({
      toolUseId: "backend-1",
      status: "success",
      content: [new TextBlock(JSON.stringify({ ok: true }))],
    });
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: {
            toolUseId: "backend-1",
            name: "backend_tool",
            input: { x: 1 },
          },
          tool: undefined,
          result: resultBlock,
        } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput(), agent);
    const result = events.find(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_RESULT,
    ) as { toolCallId: string; content: string };
    expect(result).toBeDefined();
    expect(result.toolCallId).toBe("backend-1");
    expect(JSON.parse(result.content)).toEqual({ ok: true });
  });

  it("emits a PredictState CustomEvent when ToolBehavior.predictState is configured", async () => {
    const block = new ToolUseBlock({
      name: "set_recipe",
      toolUseId: "u-1",
      input: { name: "Soup" },
    });
    const stub = scriptedAgent([block as unknown as AgentStreamEvent]);
    const agent = new TestableStrandsAgent(stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_recipe: {
          predictState: [
            { stateKey: "recipe", tool: "set_recipe", toolArgument: "data" },
          ],
        },
      },
    };
    const events = await collect(minimalRunInput(), agent);
    const custom = events.find(
      (e) =>
        (e as { type: string }).type === EventType.CUSTOM &&
        (e as { name: string }).name === "PredictState",
    ) as { value: unknown[] };
    expect(custom).toBeDefined();
    expect(custom.value).toEqual([
      { state_key: "recipe", tool: "set_recipe", tool_argument: "data" },
    ]);
  });
});

describe("StrandsAgent.run — reasoning", () => {
  it("emits REASONING_* events and closes on contentBlockStop", async () => {
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "reasoningContentDelta", text: "thinking..." },
        } as unknown as AgentStreamEvent,
        { type: "modelContentBlockStopEvent" } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput(), agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.REASONING_START);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_START);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_END);
    expect(kinds).toContain(EventType.REASONING_END);
  });

  it("base64-encodes redactedContent into REASONING_ENCRYPTED_VALUE", async () => {
    const agent = new TestableStrandsAgent(
      scriptedAgent([
        {
          type: "modelContentBlockDeltaEvent",
          delta: {
            type: "reasoningContentDelta",
            redactedContent: new Uint8Array([0x41, 0x42, 0x43]),
          },
        } as unknown as AgentStreamEvent,
      ]),
    );
    const events = await collect(minimalRunInput(), agent);
    const enc = events.find(
      (e) =>
        (e as { type: string }).type === EventType.REASONING_ENCRYPTED_VALUE,
    ) as { encryptedValue: string };
    expect(enc).toBeDefined();
    expect(enc.encryptedValue).toBe("QUJD");
  });
});

describe("StrandsAgent.run — session-manager provider", () => {
  it("emits RUN_ERROR(SESSION_MANAGER_ERROR) if the provider throws", async () => {
    const stub = scriptedAgent([]);
    const agent = new StrandsAgent({
      agent: stub,
      name: "t",
      config: {
        sessionManagerProvider: () => {
          throw new Error("no session for you");
        },
      },
    });
    const events = await collect(
      minimalRunInput({ threadId: "fresh-thread" }),
      agent,
    );
    const kinds = types(events);
    expect(kinds).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    const err = events[1] as { message: string; code: string };
    expect(err.code).toBe("SESSION_MANAGER_ERROR");
    expect(err.message).toContain("no session for you");
  });

  it("emits RUN_ERROR(SESSION_MANAGER_INVALID_TYPE) if the provider returns garbage", async () => {
    const stub = scriptedAgent([]);
    const agent = new StrandsAgent({
      agent: stub,
      name: "t",
      config: {
        // Empty object with no HookProvider shape.
        sessionManagerProvider: () => ({ unrelated: true }) as never,
      },
    });
    const events = await collect(
      minimalRunInput({ threadId: "fresh-thread-2" }),
      agent,
    );
    const kinds = types(events);
    expect(kinds).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect((events[1] as { code: string }).code).toBe(
      "SESSION_MANAGER_INVALID_TYPE",
    );
  });
});

describe("StrandsAgent.run — state context builder", () => {
  it("lets the builder rewrite the prompt before it's forwarded to Strands", async () => {
    let capturedArgs: unknown = null;
    const stub = {
      model: {},
      messages: [] as unknown[],
      tools: [],
      toolRegistry: {
        values: () => [],
        add() {},
        getByName: () => undefined,
        removeByName() {},
      },
      async *stream(prompt: unknown) {
        capturedArgs = prompt;
      },
    } as unknown as import("@strands-agents/sdk").Agent & {
      messages: unknown[];
    };

    const agent = new TestableStrandsAgent(stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `${prompt} [STATE:ok]`,
    };

    await collect(
      minimalRunInput({
        messages: [{ id: "m1", role: "user", content: "Hi there" }],
      }),
      agent,
    );
    // History reconciliation moves the prompt onto agent.messages and the
    // adapter calls stream(undefined). The builder is applied to the last
    // user-text turn in the replayed history (Python parity).
    expect(capturedArgs).toBeUndefined();
    const replayed = stub.messages as Array<{
      role: string;
      content: Array<{ text?: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.content[0]!.text).toBe("Hi there [STATE:ok]");
  });
});

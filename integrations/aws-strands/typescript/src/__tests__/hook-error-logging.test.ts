/**
 * Hook exceptions must be logged with the raw Error object so Node prints
 * the stack trace, not `String(e)` which produces "Error: boom" with no
 * context.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

/** Stub Strands Agent that scripts its own stream. */
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

describe("hook error logging", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    spy?.mockRestore();
  });

  it("stateContextBuilder exception logs the Error object", async () => {
    spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new Testable(scriptedAgent([]));
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: () => {
        throw new Error("builder bombed");
      },
    };
    await drain(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hi" }],
      }),
    );
    // First arg is the prefix string, second is the Error itself.
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("stateContextBuilder"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("builder bombed");
  });

  it("stateFromArgs exception logs the Error object", async () => {
    spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Emit a tool-use block so the hook site fires.
    const { ToolUseBlock } = await import("@strands-agents/sdk");
    const block = new ToolUseBlock({
      name: "Multiply",
      toolUseId: "u1",
      input: { a: 1, b: 2 },
    });
    const agent = new Testable(scriptedAgent([block]));
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        Multiply: {
          stateFromArgs: () => {
            throw new Error("args hook bombed");
          },
        },
      },
    };
    await drain(agent, minimalRunInput());
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("stateFromArgs"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("args hook bombed");
  });

  it("argsStreamer exception logs the Error and still emits fallback args", async () => {
    spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ToolUseBlock } = await import("@strands-agents/sdk");
    const block = new ToolUseBlock({
      name: "Multiply",
      toolUseId: "u1",
      input: { a: 1, b: 2 },
    });
    const agent = new Testable(scriptedAgent([block]));
    // eslint-disable-next-line require-yield
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        Multiply: {
          argsStreamer: async function* () {
            throw new Error("streamer bombed");
          },
        },
      },
    };
    const events = await drain(agent, minimalRunInput());
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("argsStreamer"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("streamer bombed");
    // Fallback TOOL_CALL_ARGS should still fire with the full args blob.
    const args = events.find(
      (e) => (e as { type: string }).type === EventType.TOOL_CALL_ARGS,
    ) as { delta: string };
    expect(JSON.parse(args.delta)).toEqual({ a: 1, b: 2 });
  });
});

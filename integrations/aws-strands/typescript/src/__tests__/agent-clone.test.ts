/**
 * Verifies that the adapter prefers `template.clone({...})` when the
 * template Agent exposes a `clone` method (Strands SDK ≥ feat/agent-clone).
 *
 * The legacy slice-and-rebuild path is exercised by
 * `agent-config-forwarded.test.ts`, which mocks the SDK with an Agent
 * stub that has no `clone` method.
 */

import { describe, it, expect, vi } from "vitest";
import { Agent as MockedAgent } from "@strands-agents/sdk";
import type { AgentConfig, Plugin } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { collect } from "./helpers";

interface CapturedClone {
  /** The bound `template.clone` was invoked on this template instance. */
  template: unknown;
  options: unknown;
}

const capturedClones: CapturedClone[] = [];

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();

  /** Minimal tool registry mirroring what the adapter touches. */
  function makeToolRegistry() {
    const tools = new Map<string, unknown>();
    return {
      _tools: tools,
      add(t: unknown) {
        tools.set((t as { name: string }).name, t);
      },
      get(n: string) {
        return tools.get(n);
      },
      getByName(n: string) {
        return tools.get(n);
      },
      remove(t: unknown) {
        const name =
          typeof t === "string" ? t : (t as { name?: string })?.name;
        if (name) tools.delete(name);
      },
      removeByName(n: string) {
        tools.delete(n);
      },
      values() {
        return Array.from(tools.values());
      },
    };
  }

  /**
   * Stub Agent with a real `clone` method. Tracks every clone() call so
   * the adapter test can assert on the options shape.
   */
  class CloneCapableAgent {
    model: unknown;
    tools: unknown[];
    toolRegistry = makeToolRegistry();
    sessionManager?: unknown;
    cfg: AgentConfig;

    constructor(cfg?: AgentConfig) {
      this.cfg = { ...(cfg ?? {}) };
      this.model = this.cfg.model;
      this.tools = (this.cfg.tools as unknown[]) ?? [];
      if (this.cfg.sessionManager !== undefined)
        this.sessionManager = this.cfg.sessionManager;
    }

    clone(options?: unknown): CloneCapableAgent {
      capturedClones.push({ template: this, options });
      // Naive merge — production clone is in agent.ts, this just needs
      // to return a fresh instance the adapter can stream against.
      const overrides =
        (options as { overrides?: Partial<AgentConfig> } | undefined)
          ?.overrides ?? {};
      const merged: AgentConfig = {
        ...this.cfg,
        ...overrides,
        printer: false,
      };
      return new CloneCapableAgent(merged);
    }

    // eslint-disable-next-line require-yield
    async *stream() {}
  }

  return { ...actual, Agent: CloneCapableAgent };
});

function template(extra: Record<string, unknown> = {}) {
  // Construct via the mocked Agent so it carries clone() naturally.
  return new MockedAgent({
    model: { name: "tpl-model" } as never,
    tools: [],
    name: "tpl-agent",
    description: "the template",
    id: "tpl",
    ...extra,
  });
}

describe("StrandsAgent uses template.clone() when available", () => {
  it("invokes template.clone() once per fresh thread", async () => {
    capturedClones.length = 0;
    const sa = new StrandsAgent({ agent: template(), name: "agui" });
    await collect(sa);
    expect(capturedClones).toHaveLength(1);
  });

  it("forwards printer=false in clone overrides", async () => {
    capturedClones.length = 0;
    const sa = new StrandsAgent({ agent: template(), name: "agui" });
    await collect(sa);
    const opts = capturedClones[0]!.options as {
      overrides: { printer: boolean };
    };
    expect(opts.overrides.printer).toBe(false);
  });

  it("forwards adapter-level plugins as additionalPlugins, not overrides", async () => {
    capturedClones.length = 0;
    const plugin: Plugin = { name: "p", initAgent: () => {} };
    const sa = new StrandsAgent({
      agent: template(),
      name: "agui",
      plugins: [plugin],
    });
    await collect(sa);
    const opts = capturedClones[0]!.options as {
      overrides: Record<string, unknown>;
      additionalPlugins: Plugin[];
    };
    expect(opts.additionalPlugins).toEqual([plugin]);
    expect("plugins" in opts.overrides).toBe(false);
  });

  it("does not invoke clone() again on a hot thread", async () => {
    capturedClones.length = 0;
    const sa = new StrandsAgent({ agent: template(), name: "agui" });
    await collect(sa);
    await collect(sa);
    expect(capturedClones).toHaveLength(1);
  });

  it("invokes clone() per distinct threadId", async () => {
    capturedClones.length = 0;
    const sa = new StrandsAgent({ agent: template(), name: "agui" });
    await collect(sa, {
      threadId: "t1",
      runId: "r1",
      state: {},
      messages: [],
      tools: [],
      context: [],
    });
    await collect(sa, {
      threadId: "t2",
      runId: "r2",
      state: {},
      messages: [],
      tools: [],
      context: [],
    });
    expect(capturedClones).toHaveLength(2);
  });

  it("resolves Plugin factories per thread so each clone gets a fresh instance", async () => {
    capturedClones.length = 0;
    const factory = vi.fn(() => ({ name: "p", initAgent: () => {} }) satisfies Plugin);
    const sa = new StrandsAgent({
      agent: template(),
      name: "agui",
      plugins: [factory],
    });
    await collect(sa, {
      threadId: "t1",
      runId: "r1",
      state: {},
      messages: [],
      tools: [],
      context: [],
    });
    await collect(sa, {
      threadId: "t2",
      runId: "r2",
      state: {},
      messages: [],
      tools: [],
      context: [],
    });
    expect(factory).toHaveBeenCalledTimes(2);
    const opts1 = capturedClones[0]!.options as { additionalPlugins: Plugin[] };
    const opts2 = capturedClones[1]!.options as { additionalPlugins: Plugin[] };
    expect(opts1.additionalPlugins[0]).not.toBe(opts2.additionalPlugins[0]);
  });
});

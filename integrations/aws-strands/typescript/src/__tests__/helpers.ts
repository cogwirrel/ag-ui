/**
 * Shared test helpers. These mirror the Python test helpers but adapted for
 * the TS Strands SDK's streaming shape.
 */

import type { RunAgentInput } from "@ag-ui/core";

export function minimalRunInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: overrides.threadId ?? "thread-1",
    runId: overrides.runId ?? "run-1",
    state: overrides.state ?? {},
    messages: overrides.messages ?? [],
    tools: overrides.tools ?? [],
    context: overrides.context ?? [],
    forwardedProps: overrides.forwardedProps,
    ...overrides,
  };
}

/**
 * Builds a fake `Tool` instance whose identity we can assert on without
 * actually driving a Strands Agent. Matches the minimal Tool contract
 * (`name`, `description`, `toolSpec`, async `stream`).
 */
export function fakeTool(name: string, description = "") {
  return {
    name,
    description,
    toolSpec: {
      name,
      description,
      inputSchema: { json: {} },
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      return { toolUseId: "x", status: "success" as const, content: [] };
    },
  };
}

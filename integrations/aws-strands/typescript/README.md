# AWS Strands Integration for AG-UI (TypeScript)

This package exposes a lightweight wrapper that lets any `@strands-agents/sdk` `Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to Express via `createStrandsApp` (or `addStrandsExpressEndpoint`).

## Prerequisites

- Node.js 18+
- `pnpm` (recommended) or `npm`
- A Strands-compatible model key (e.g., AWS credentials for Bedrock, `OPENAI_API_KEY` for OpenAI)

## Quick Start

The `examples/` package ships a "dojo" server that mounts every demo on a
single port, plus seven standalone servers — one per feature — that you can
run independently.

```bash
# from the repo root
pnpm install
pnpm --filter @ag-ui/aws-strands build

cd integrations/aws-strands/typescript/examples
pnpm dojo                       # all examples at http://localhost:8002
```

Or run any single example on its own port (default `8000`):

```bash
pnpm agentic-chat
pnpm agentic-chat-reasoning
pnpm agentic-chat-multimodal
pnpm backend-tool-rendering
pnpm shared-state
pnpm agentic-generative-ui
pnpm human-in-the-loop
```

The dojo exposes:

| Route                      | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `/agentic-chat`            | Baseline chat; frontend tools auto-registered from `RunAgentInput.tools` |
| `/agentic-chat-reasoning`  | Reasoning / thinking event streaming                                     |
| `/agentic-chat-multimodal` | Multimodal image / document analysis                                     |
| `/backend-tool-rendering`  | Backend-executed tools (`get_weather`, `render_chart`)                   |
| `/shared-state`            | Shared recipe state (`stateFromArgs`)                                    |
| `/agentic-generative-ui`   | Async-generator tool streams `STATE_SNAPSHOT`s + `PredictState`          |
| `/human-in-the-loop`       | Frontend proxy tool with halt-after-call                                 |

Each standalone file under `examples/server/api/*.ts` follows the same pattern: build a Strands `Agent`, wrap it in a `StrandsAgent`, hand it to `createStrandsApp`, listen.

## Architecture Overview

The integration has three main layers:

- **StrandsAgent** – wraps `Agent.stream()` from `@strands-agents/sdk`. It translates Strands streaming events into AG-UI events (text chunks, tool calls, PredictState, snapshots, reasoning/thinking, multi-agent steps, etc.).
- **Configuration** – `StrandsAgentConfig` + `ToolBehavior` + `PredictStateMapping` let you describe tool-specific quirks declaratively (skip message snapshots, emit state, stream args, etc.).
- **Transport helpers** – `createStrandsApp` and `addStrandsExpressEndpoint` expose the agent via SSE. They are thin shells over the shared `@ag-ui/encoder` `EventEncoder`.

See [../ARCHITECTURE.md](../ARCHITECTURE.md) for diagrams and a deeper dive.

## Key Files

| File                       | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `src/agent.ts`             | Core wrapper translating Strands streams into AG-UI events                      |
| `src/config.ts`            | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/endpoint.ts`          | Express endpoint helper                                                         |
| `src/utils.ts`             | App factory + multimodal content conversion                                     |
| `src/client-proxy-tool.ts` | Dynamic frontend tool registration/deregistration                               |
| `examples/server/api/*.ts` | Ready-to-run demo apps                                                          |

## Amazon Bedrock AgentCore Considerations

If you are planning to deploy your agent into Amazon Bedrock AgentCore (AC), please note that AC expects the following:

- The server is running on port 8080.
- The path `/invocations - POST` is implemented and can be used for interacting with the agent.
- The path `/ping - GET` is implemented and can be used for verifying that the agent is operational and ready to handle requests.

To implement the paths mentioned above, you can use the helper function `createStrandsApp` and pass the agent interaction path and the ping path as shown below:

```ts
const app = await createStrandsApp(aguiAgent, {
  path: "/invocations",
  pingPath: "/ping",
});
app.listen(8080);
```

You can also use the helper functions `addStrandsExpressEndpoint` and `addPing` for adding the mentioned paths to an Express app that you are creating separately:

```ts
import express from "express";
import cors from "cors";
import { addStrandsExpressEndpoint, addPing } from "@ag-ui/aws-strands";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
addStrandsExpressEndpoint(app, aguiAgent, { path: "/invocations" });
addPing(app, "/ping");
app.listen(8080);
```

Requests to the AC endpoint must be authenticated. You can configure your agent runtime to accept JWT bearer tokens (via Amazon Cognito) or use SigV4. See [Set up authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) in the AgentCore documentation.

For details on how AgentCore handles AG-UI requests, event streaming, and error formatting, see the [AG-UI protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html).

To deploy, use the [AgentCore Starter Toolkit](https://github.com/awslabs/bedrock-agentcore-starter-toolkit):

```bash
pip install bedrock-agentcore-starter-toolkit
agentcore configure -e my_agui_server.ts --protocol AGUI
agentcore deploy
```

For the complete deployment walkthrough, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html).

### npm install tips for AgentCore

The Node.js container image the starter toolkit generates runs `npm ci` inside
the CodeBuild cross-compile step. Two papercuts to be aware of:

1. **Peer-dep conflict.** `@strands-agents/sdk`'s `peerOptional` on
   `@opentelemetry/exporter-metrics-otlp-http@^0.214.0` clashes with the
   `@opentelemetry/auto-instrumentations-node` bundle the toolkit wraps the
   runtime with. Work around it by adding a project-local `.npmrc`:

   ```
   legacy-peer-deps=true
   ```

   The toolkit copies `.npmrc` into the CodeBuild archive.

2. **`@modelcontextprotocol/sdk` is loaded unconditionally by the Strands SDK.**
   Declare it as a direct dependency of your deployment project so the
   container has it at runtime; omitting it causes the process to
   crash-loop with `ERR_MODULE_NOT_FOUND: Cannot find package
'@modelcontextprotocol/sdk'`.

   ```bash
   pnpm add @modelcontextprotocol/sdk
   ```

## Supported AG-UI Events

The integration supports the following AG-UI event families:

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text streaming**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` (optionally collapsed into `TEXT_MESSAGE_CHUNK` via `StrandsAgentConfig.emitChunkEvents`)
- **Reasoning**: `REASONING_*` events for models with extended thinking (`REASONING_MESSAGE_CHUNK` when `emitChunkEvents` is on)
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` (or `TOOL_CALL_CHUNK` with `emitChunkEvents`)
- **State management**: `STATE_SNAPSHOT`
- **Multi-agent**: `STEP_STARTED`, `STEP_FINISHED`, and `MultiAgentHandoff` custom events
- **Generative UI**: `PredictState` custom events for optimistic UI updates
- **Multimodal**: Image, document, and video content in user messages (converted to Strands ContentBlock format)

The adapter advertises its full event / feature matrix at GET
`/capabilities` (enabled by default; override via `createStrandsApp({ capabilitiesPath, capabilities })` or mount manually with `addCapabilities(app, path, overrides)`).

## Not yet supported

The following AG-UI protocol features are **not** wired up in this adapter:

- **Interrupts / resume.** The adapter does not issue interrupts or expose a
  resume loop: `RUN_FINISHED.outcome = { type: "interrupt", interrupts: [...] }`
  is never emitted. Any `RunAgentInput.resume[]` entry therefore points at an
  unknown interrupt by definition, and the adapter enforces
  [interrupts.mdx rule 4](https://docs.ag-ui.com/concepts/interrupts) by
  emitting `RUN_ERROR { code: "UNKNOWN_INTERRUPT" }` instead of silently
  proceeding. The `/human-in-the-loop` example demonstrates confirmation via a
  frontend tool — that is the supported pattern today. If you need native
  interrupt semantics (tool-call approval with `editedArgs`, `input_required`
  interrupts, etc.) open an issue; mapping onto Strands' hook lifecycle is a
  design conversation.
- **Resumable streams / sequence numbers.** Streams are one-shot: a dropped
  connection cannot be resumed mid-run. Retry from `messages[]` history.
- **`ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` / `RAW` events.** Not emitted by
  the adapter; consumers can still yield them from a `customResultHandler`.

## Reasoning / extended thinking

The `/agentic-chat-reasoning` demo only emits `REASONING_*` events when the
underlying Strands model is configured with thinking / reasoning params. The
default `BedrockModel(...)` without `additional_request_fields` returns plain
text; for Claude extended thinking, configure the model like so:

```ts
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";

const model = new BedrockModel({
  modelId: "global.anthropic.claude-sonnet-4-6",
  additionalRequestFields: {
    thinking: { type: "enabled", budget_tokens: 5000 },
  },
});
```

## Install

```bash
pnpm add @ag-ui/aws-strands @strands-agents/sdk @ag-ui/core @ag-ui/encoder
# Server-side helpers (createStrandsApp / addStrandsExpressEndpoint) require express + cors:
pnpm add express cors
pnpm add -D @types/express @types/cors
# @modelcontextprotocol/sdk is loaded unconditionally by @strands-agents/sdk
# — required at runtime even for agents that don't use MCP:
pnpm add @modelcontextprotocol/sdk
```

## Server: Expose a Strands Agent via AG-UI

```ts
import { Agent } from "@strands-agents/sdk";
import { StrandsAgent, createStrandsApp } from "@ag-ui/aws-strands";

// `model` accepts either a Bedrock model ID string or a constructed
// Model instance (e.g. BedrockModel / AnthropicModel / OpenAIResponsesModel).
// Omitting it uses Strands' current Bedrock default.
const strandsAgent = new Agent({
  systemPrompt: "You are a helpful assistant.",
  tools: [],
});

const aguiAgent = new StrandsAgent({
  agent: strandsAgent,
  name: "MyAgent",
  description: "A Strands agent exposed via AG-UI",
});

const app = await createStrandsApp(aguiAgent, { path: "/invocations" });
app.listen(8000);
```

## Configuration

```ts
import {
  StrandsAgent,
  type StrandsAgentConfig,
  type ToolBehavior,
} from "@ag-ui/aws-strands";

const config: StrandsAgentConfig = {
  toolBehaviors: {
    set_recipe: {
      stateFromArgs: async (ctx) => ({ recipe: ctx.toolInput }),
      predictState: [
        { stateKey: "recipe", tool: "set_recipe", toolArgument: "data" },
      ],
    },
    render_chart: {
      stopStreamingAfterResult: true,
    },
  },
  sessionManagerProvider: async (input) => {
    // Optional: vend a SessionManager per-thread from your own state store.
    return undefined;
  },
  stateContextBuilder: (input, prompt) => {
    // Optional: decorate the outgoing prompt with any server-side state.
    return prompt;
  },
};

const agent = new StrandsAgent({ agent: strandsAgent, name: "x", config });
```

## Low-Level Transport

If you have an existing Express app, mount the endpoint directly instead of
using `createStrandsApp`:

```ts
import express from "express";
import cors from "cors";
import { addStrandsExpressEndpoint, addPing } from "@ag-ui/aws-strands";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
addStrandsExpressEndpoint(app, aguiAgent, { path: "/invocations" });
addPing(app, "/ping");
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

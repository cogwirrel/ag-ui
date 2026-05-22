/**
 * Verification server: mounts every TS example on the same paths the Python
 * reference server uses, so both implementations can be driven by the same
 * curl payloads.
 */
import express from "express";
import cors from "cors";
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from "@ag-ui/aws-strands/server";
import { createModel } from "./model-factory";

function mountAgent(
  app: express.Express,
  path: string,
  aguiAgent: StrandsAgent,
): void {
  addStrandsExpressEndpoint(app, aguiAgent, { path });
  addStrandsExpressEndpoint(app, aguiAgent, { path: `${path}/` });
}

async function main(): Promise<void> {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "50mb" }));
  addPing(app, "/ping");
  addCapabilities(app, "/capabilities");

  /* ---------------- agentic-chat ---------------- */
  const chatAgent = new Agent({
    model: await createModel(),
    systemPrompt: `
      You are a helpful assistant.
      When the user greets you, always greet them back. Your greeting should always start with "Hello".
      Your greeting should also always ask (exact wording) "how can I assist you?"
    `,
  });
  mountAgent(
    app,
    "/agentic-chat",
    new StrandsAgent({
      agent: chatAgent,
      name: "agentic_chat",
      description: "Conversational Strands agent with AG-UI streaming",
    }),
  );

  /* ---------------- agentic-chat-reasoning ---------------- */
  const reasoningAgent = new Agent({
    model: await createModel({ reasoning: true }),
    systemPrompt: `
      You are a helpful assistant that thinks through problems step by step.
      When reasoning about a problem, break it down into clear steps before answering.
    `,
  });
  mountAgent(
    app,
    "/agentic-chat-reasoning",
    new StrandsAgent({
      agent: reasoningAgent,
      name: "agentic_chat_reasoning",
      description: "Reasoning agent",
    }),
  );

  /* ---------------- agentic-chat-multimodal ---------------- */
  const multimodalAgent = new Agent({
    model: await createModel(),
    systemPrompt:
      "You are a helpful assistant that can analyze images and documents. Describe images in detail.",
  });
  mountAgent(
    app,
    "/agentic-chat-multimodal",
    new StrandsAgent({
      agent: multimodalAgent,
      name: "agentic_chat_multimodal",
      description: "Multimodal chat",
    }),
  );

  /* ---------------- backend-tool-rendering ---------------- */
  // Schema mirrors python/examples/server/api/backend_tool_rendering.py so
  // the dojo's WeatherCard (which reads `location` from args and
  // `wind_speed` / `feels_like` from the result) renders identically.
  const getWeather = tool({
    name: "get_weather",
    description: "Get weather information for a location.",
    inputSchema: z.object({
      location: z.string().describe("The location to get weather for."),
    }),
    callback: () => {
      const conditions = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"];
      const rand = (lo: number, hi: number) =>
        Math.floor(Math.random() * (hi - lo + 1)) + lo;
      return {
        temperature: rand(60, 85),
        conditions: conditions[rand(0, conditions.length - 1)],
        humidity: rand(30, 80),
        wind_speed: rand(5, 20),
        feels_like: rand(58, 88),
      };
    },
  });
  const renderChart = tool({
    name: "render_chart",
    description: "Render a chart with backend processing capabilities.",
    inputSchema: z.object({
      chart_type: z.string(),
      data: z.string(),
    }),
    callback: ({ chart_type, data }) => ({
      chart_type,
      data: data.slice(0, 100),
      status: "rendered",
    }),
  });
  const backendToolAgent = new Agent({
    model: await createModel(),
    systemPrompt:
      "You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.",
    tools: [getWeather, renderChart],
  });
  mountAgent(
    app,
    "/backend-tool-rendering",
    new StrandsAgent({
      agent: backendToolAgent,
      name: "backend_tool_rendering",
      description: "Strands agent that invokes backend tools",
    }),
  );

  /* ---------------- shared-state ---------------- */
  const recipeSchema = z.object({
    title: z.string(),
    skill_level: z.string(),
    special_preferences: z.array(z.string()),
    cooking_time: z.string(),
    ingredients: z.array(
      z.object({ icon: z.string(), name: z.string(), amount: z.string() }),
    ),
    instructions: z.array(z.string()),
    changes: z.string().default(""),
  });
  const generateRecipe = tool({
    name: "generate_recipe",
    description: "Produce a complete updated recipe.",
    inputSchema: z.object({ recipe: recipeSchema }),
    callback: () => "Recipe updated successfully",
  });
  const sharedConfig: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const recipe = state.recipe ?? {};
      return `Current recipe state:\n${JSON.stringify(recipe, null, 2)}\n\nUser request: ${prompt}\n\nPlease update the recipe by calling the registered tool.`;
    },
    toolBehaviors: {
      generate_recipe: {
        // Stream the recipe arg into state.recipe while the LLM is still
        // emitting it, so the UI fills in progressively. Mirrors the
        // langgraph shared-state demo's predict_state mapping.
        predictState: [
          {
            stateKey: "recipe",
            tool: "generate_recipe",
            toolArgument: "recipe",
          },
        ],
        stateFromArgs: async (ctx) => {
          const args = ctx.toolInput as { recipe?: unknown };
          return args?.recipe ? { recipe: args.recipe } : null;
        },
      },
    },
  };
  const sharedAgent = new Agent({
    model: await createModel(),
    systemPrompt: "You are a helpful recipe editor.",
    tools: [generateRecipe],
  });
  mountAgent(
    app,
    "/shared-state",
    new StrandsAgent({
      agent: sharedAgent,
      name: "shared_state",
      description: "Shared recipe state",
      config: sharedConfig,
    }),
  );

  /* ---------------- agentic-generative-ui ---------------- */
  const stepSchema = z.object({
    description: z.string(),
    status: z.string().default("pending"),
  });
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  const planTaskSteps = tool({
    name: "plan_task_steps",
    description: "Plan the concrete steps required to accomplish a task.",
    inputSchema: z.object({
      task: z.string(),
      context: z.string().default(""),
      steps: z.array(stepSchema),
    }),
    callback: async function* ({ task, context, steps }) {
      const normalized = (steps ?? []).map(
        (s: { description: string; status?: string }) => ({
          description: s.description,
          status: s.status || "pending",
        }),
      );
      if (normalized.length === 0) {
        return { task, context, steps: [] };
      }
      yield { state: { steps: normalized.map((s) => ({ ...s })) } };
      for (let i = 0; i < normalized.length; i++) {
        await sleep(100);
        normalized[i]!.status = "in_progress";
        yield { state: { steps: normalized.map((s) => ({ ...s })) } };
        await sleep(100);
        normalized[i]!.status = "completed";
        yield { state: { steps: normalized.map((s) => ({ ...s })) } };
      }
      return { task, context, steps: normalized };
    },
  });
  const genuiConfig: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const steps = state.steps;
      if (steps) {
        return `A plan is already in progress. NEVER call plan_task_steps again.\n\nCurrent steps:\n${JSON.stringify(steps, null, 2)}\n\nUser: ${prompt}`;
      }
      return prompt;
    },
    toolBehaviors: {
      plan_task_steps: {
        predictState: [
          { stateKey: "steps", tool: "plan_task_steps", toolArgument: "steps" },
        ],
        stateFromResult: async (ctx) => {
          const result = (ctx.resultData ?? {}) as { steps?: unknown[] };
          return result.steps ? { steps: result.steps } : null;
        },
      },
    },
  };
  const genuiAgent = new Agent({
    model: await createModel(),
    tools: [planTaskSteps],
    systemPrompt:
      "You are an energetic project assistant. When the user asks for a plan, call plan_task_steps once with 4-6 gerund-form steps.",
  });
  mountAgent(
    app,
    "/agentic-generative-ui",
    new StrandsAgent({
      agent: genuiAgent,
      name: "agentic_generative_ui",
      description: "Generative UI agent",
      config: genuiConfig,
    }),
  );

  /* ---------------- human-in-the-loop ---------------- */
  const hitlAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

**Your Primary Role:**
- Break down any user request into exactly 10 clear, actionable steps (unless the user explicitly asks for fewer)
- Each step should be brief, in imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
- Set all steps to "enabled" status initially

**When the user asks you to plan something:**
1. Use the \`generate_task_steps\` tool exactly once
2. Wait for the user's review

**When the user replies after reviewing the plan:**
- If accepted: briefly confirm the approved steps and "execute" them by repeating each in gerund form (e.g., "Digging hole... Opening door...") — DO NOT call \`generate_task_steps\` again
- If rejected: ask what they'd like to change — DO NOT call \`generate_task_steps\` again until they provide new input

**Important:**
- NEVER call \`generate_task_steps\` twice in a row without explicit new user input
- For follow-up questions about a previously executed plan, just answer in plain text — do NOT invoke any tool
`,
  });
  mountAgent(
    app,
    "/human-in-the-loop",
    new StrandsAgent({
      agent: hitlAgent,
      name: "human_in_the_loop",
      description: "HITL agent",
    }),
  );

  /* ---------------- tool-based-generative-ui ---------------- */
  const haikuAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a creative haiku generator.

When the user asks for a haiku, ALWAYS call the \`generate_haiku\` tool with:
- 3 lines of haiku in Japanese
- 3 lines of haiku translated to English
- One relevant image_name from the provided list
- A CSS gradient for the card background

Do not respond with plain text — always use the tool.`,
  });
  mountAgent(
    app,
    "/tool-based-generative-ui",
    new StrandsAgent({
      agent: haikuAgent,
      name: "tool_based_generative_ui",
      description: "Haiku generator with frontend-rendered tool",
    }),
  );

  const port = Number(process.env.PORT ?? 8022);
  const host = process.env.HOST ?? "0.0.0.0";
  app.listen(port, host, () => {
    console.log(`TS strands server listening on ${host}:${port}`);
  });
}

void main();

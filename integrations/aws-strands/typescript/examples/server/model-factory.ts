/**
 * Shared model factory for Strands TypeScript examples.
 *
 * Mirrors `python/examples/server/model_factory.py` field-for-field: same
 * `MODEL_PROVIDER` env-var shape, same defaults, same model IDs. The CI dojo
 * runner injects `OPENAI_BASE_URL=http://localhost:5555/v1` + a mock API key,
 * so the default `openai` provider routes to the aimock server automatically.
 *
 * Supported providers: `openai` (default), `anthropic`, `gemini`, `bedrock`.
 */

import type { Model } from "@strands-agents/sdk";

export async function createModel(): Promise<Model> {
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required when MODEL_PROVIDER=openai. " +
          "Set it in your .env file or environment.",
      );
    }
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    // OPENAI_BASE_URL routes through aimock during e2e tests. The default
    // Responses API surfaces fixture `reasoning` content for the
    // `/agentic-chat-reasoning` demo.
    const baseURL = process.env.OPENAI_BASE_URL;
    return new OpenAIModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "gpt-5.4",
      params: {
        reasoning: { effort: "medium", summary: "auto" },
      },
      ...(baseURL ? { clientConfig: { baseURL } } : {}),
    });
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required when MODEL_PROVIDER=anthropic. " +
          "Set it in your .env file or environment.",
      );
    }
    const { AnthropicModel } = await import(
      "@strands-agents/sdk/models/anthropic"
    );
    return new AnthropicModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "claude-sonnet-4-6",
    });
  }

  if (provider === "gemini") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_API_KEY environment variable is required when MODEL_PROVIDER=gemini. " +
          "Set it in your .env file or environment.",
      );
    }
    const { GoogleModel } = await import("@strands-agents/sdk/models/google");
    return new GoogleModel({
      apiKey,
      modelId: process.env.MODEL_ID ?? "gemini-2.5-flash",
    });
  }

  if (provider === "bedrock") {
    const { BedrockModel } = await import("@strands-agents/sdk");
    return new BedrockModel({
      modelId: process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
    });
  }

  throw new Error(
    `Unknown MODEL_PROVIDER: ${provider}. Supported: openai, anthropic, gemini, bedrock`,
  );
}

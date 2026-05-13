/** AWS Strands integration for AG-UI. */

export {
  StrandsAgent,
  buildSnapshotMessages,
  buildStrandsSeed,
  convertMessagesForStrandsSeed,
} from "./agent";
export type { StrandsAgentOptions } from "./agent";

export {
  createProxyTool,
  syncProxyTools,
  isProxyTool,
} from "./client-proxy-tool";
export type { StrandsToolRegistry } from "./client-proxy-tool";

export {
  createStrandsApp,
  convertAguiContentToStrands,
  flattenContentToText,
} from "./utils";
export type { CreateStrandsAppOptions } from "./utils";

export {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
} from "./endpoint";
export type {
  AddStrandsEndpointOptions,
  StrandsAguiCapabilities,
  StrandsAguiCapabilitiesOverrides,
} from "./endpoint";

export type { Logger } from "./logger";

export { buildContextExtras } from "./config";
export type {
  StrandsAgentConfig,
  ToolBehavior,
  ToolCallContext,
  ToolCallContextExtras,
  ToolResultContext,
  PredictStateMapping,
  SessionManagerProvider,
  StateContextBuilder,
  StateFromArgs,
  StateFromResult,
  CustomResultHandler,
  ArgsStreamer,
  MaybePromise,
  StatePayload,
} from "./config";

// Thin HttpAgent subclass for AG-UI clients pointing at a Strands endpoint.
import { HttpAgent } from "@ag-ui/client";
export class AWSStrandsAgent extends HttpAgent {}

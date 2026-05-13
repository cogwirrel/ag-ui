/** Every public helper must be reachable from the package entry point. */

import { describe, it, expect } from "vitest";
import * as pkg from "../index";

describe("public export surface", () => {
  it("exposes the adapter, proxy helpers, capabilities helpers, and context helper", () => {
    const expected = [
      "StrandsAgent",
      "AWSStrandsAgent",
      "buildSnapshotMessages",
      "buildStrandsSeed",
      "convertMessagesForStrandsSeed",
      "buildContextExtras",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
      "capabilitiesFor",
      "DEFAULT_CAPABILITIES",
      "createStrandsApp",
      "convertAguiContentToStrands",
      "flattenContentToText",
      "createProxyTool",
      "syncProxyTools",
      "isProxyTool",
    ];
    for (const name of expected) {
      expect(pkg).toHaveProperty(name);
      expect((pkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildLoopbackOverrideArg, handlePluginRequest } from "../src/plugin.js";

const PROTOCOL = "agent-browser.plugin.v1";

test("buildLoopbackOverrideArg returns one comma-containing Chrome argv item", () => {
  assert.equal(
    buildLoopbackOverrideArg(),
    "--ip-address-space-overrides=127.0.0.0/8=public,[::1]/128=public"
  );
});

test("plugin.manifest declares a launch mutator plugin", () => {
  assert.deepEqual(
    handlePluginRequest({
      protocol: PROTOCOL,
      type: "plugin.manifest",
      capability: "plugin.manifest",
      request: {}
    }),
    {
      protocol: PROTOCOL,
      success: true,
      manifest: {
        name: "allow-loopback",
        capabilities: ["launch.mutate"],
        description: "Allow loopback Local Network Access handoff flows in agent-browser Chrome sessions."
      }
    }
  );
});

test("launch.mutate appends the loopback address-space override", () => {
  assert.deepEqual(
    handlePluginRequest({
      protocol: PROTOCOL,
      type: "launch.mutate",
      capability: "launch.mutate",
      request: {
        launchOptions: {
          args: []
        }
      }
    }),
    {
      protocol: PROTOCOL,
      success: true,
      launch: {
        args: [
          "--ip-address-space-overrides=127.0.0.0/8=public,[::1]/128=public"
        ]
      }
    }
  );
});

test("unsupported request types return success false", () => {
  const response = handlePluginRequest({
    protocol: PROTOCOL,
    type: "credential.resolve",
    capability: "credential.read",
    request: {}
  });

  assert.equal(response.protocol, PROTOCOL);
  assert.equal(response.success, false);
  assert.match(response.error, /unsupported request type/u);
});

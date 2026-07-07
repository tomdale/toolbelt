const PROTOCOL = "agent-browser.plugin.v1";
const PLUGIN_NAME = "allow-loopback";
const CAPABILITY = "launch.mutate";
const LOOPBACK_OVERRIDE = "127.0.0.0/8=public,[::1]/128=public";
const OVERRIDE_SWITCH = "--ip-address-space-overrides";

export function buildLoopbackOverrideArg() {
  return `${OVERRIDE_SWITCH}=${LOOPBACK_OVERRIDE}`;
}

export function handlePluginRequest(payload) {
  if (!payload || typeof payload !== "object") {
    return failure("request must be a JSON object");
  }

  if (payload.protocol !== PROTOCOL) {
    return failure(`unsupported protocol '${String(payload.protocol)}'`);
  }

  switch (payload.type) {
    case "plugin.manifest":
      return {
        protocol: PROTOCOL,
        success: true,
        manifest: {
          name: PLUGIN_NAME,
          capabilities: [CAPABILITY],
          description: "Allow loopback Local Network Access handoff flows in agent-browser Chrome sessions."
        }
      };
    case "launch.mutate":
      return {
        protocol: PROTOCOL,
        success: true,
        launch: {
          args: [buildLoopbackOverrideArg()]
        }
      };
    default:
      return failure(`unsupported request type '${String(payload.type)}'`);
  }
}

function failure(error) {
  return {
    protocol: PROTOCOL,
    success: false,
    error
  };
}

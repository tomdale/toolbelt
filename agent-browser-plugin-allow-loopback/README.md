# agent-browser-plugin-allow-loopback

Launch mutator plugin for `agent-browser` that allows Chrome localhost handoff
flows by treating loopback addresses as public for Local Network Access.

The plugin appends one Chrome launch argument:

```text
--ip-address-space-overrides=127.0.0.0/8=public,[::1]/128=public
```

This is useful for SSO/native app handoff flows that connect from a website to a
local helper on `127.0.0.1` or `::1`. Because the plugin returns a structured
JSON array through `launch.mutate`, the comma in the Chrome flag is preserved.

## Install

```sh
agent-browser plugin add agent-browser-plugin-allow-loopback
```

Manual config:

```json
{
  "plugins": [
    {
      "name": "allow-loopback",
      "command": "agent-browser-plugin-allow-loopback",
      "capabilities": ["launch.mutate"]
    }
  ]
}
```

## Security

This plugin changes Chrome's address-space classification for all loopback
targets in the launched browser process. It is process-wide, not origin-scoped.
Use `LoopbackNetworkAllowedForUrls` managed policy when you need a narrower
origin-scoped exception.

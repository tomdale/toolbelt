# Upstream

This package is a fork of `@zhcsyncer/pi-recap`.

- Source: https://github.com/zhcsyncer/pi-extensions, directory `packages/pi-recap`
- Base commit: `d83099f16935fcc7c3c8a94e69edc6d058158d7c` (package version 0.4.1)
- License: MIT, copyright zhcsyncer (see `LICENSE`)

## Local changes

- The recap request sends the conversation as a plain string, so transcript
  images never reach the model as image parts.
- The recap request sets `reasoning: "off"` to keep the output budget for the
  recap itself.
- When title generation is off, the model returns the recap as plain text
  instead of JSON with an empty title.
- The recap widget and error widget render inside a rounded border instead of
  a `RECAP` label prefix; the progress widget reads `Generating...`.
- `/recap-hide` clears the current recap widget.
- Package metadata names `@tomdale/pi-recap` and points at this repository.

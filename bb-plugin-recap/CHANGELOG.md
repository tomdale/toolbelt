# Changelog

All notable changes to Recap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- Simplify the composer recap to accent-colored recap text with a dismiss
  button; dismissing hides only the current recap.
- Generate recaps in place from the thread header and command palette; the
  header button shows progress and errors appear as notifications.
- Replace compact/card/on-demand layouts with **Recap** and **None** display options. In **None**, a **Generate Recap** button appears inline after the thread settles, stays hidden while a turn runs, shows an in-place progress placeholder while generating, and is replaced by the just-in-time recap. Automatic recaps are not generated while display is **None**.

### Removed

- Remove the Recap side panel.

## 0.2.2 - 2026-09-25

### Changed

- Prevent recap generation for hidden threads, including hidden workers.
- Abort generation when a thread becomes hidden and recheck visibility before
  submitting its transcript.

## 0.2.1 - 2026-09-14

### Changed

- Refresh recaps with the previous summary and only the new turns, reducing repeated transcript input.

## 0.2.0 - 2026-08-31

### Added

- Limit concurrent recap workers and retry transient automatic failures.
- Capture fictional-data screenshots of recap displays and settings.

### Changed

- Schedule automatic recaps from thread activity instead of scanning idle threads at startup.
- Hide the composer recap banner while editing an inline message.

## 0.1.0 - 2026-08-30

### Added

- Release Recap as a BB plugin for generating and displaying thread summaries.

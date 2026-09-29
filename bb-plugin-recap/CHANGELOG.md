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
- Remove the separate display setting (compact banner, recap card, on demand); **Automatic recaps** now decides what the composer shows. When it is off, a **Generate Recap** button appears inline after the thread settles, stays hidden while a turn runs, shows an in-place progress placeholder while generating, and is replaced by the just-in-time recap. Saved **On demand** preferences load with automatic recaps off.

- Write recaps at three zoom levels—**Goal**, **Now**, and **Latest**, or **Needs you** when the session is waiting on the developer—shown as labeled rows above the composer. Older recaps and custom prompts still render as plain text.
- Build long-thread transcripts from the opening request, the developer's messages, and the recent conversation instead of the newest 120,000 characters, so the goal survives in long sessions. Refreshes include the opening request alongside the previous recap and new turns.
- Label BB orchestration messages (child-thread completions, cross-thread messages) as system notices rather than developer requests, and give the worker the thread title as a hint.
- Store the recap prompt only when it is customized, so saved settings pick up future default prompts. Prompts matching an earlier default load as the current default.

### Fixed

- Keep agent reasoning, raw provider events, and resolved environment dumps (which could include credential values) out of the recap worker's transcript, and cap tool and command output so it no longer crowds out the conversation.

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

# AGENTS

## Project Purpose

This repository contains a Node.js library that exposes Microsoft Presenter+ button events to other applications.

## Current Scope

- Linux only
- Node.js runtime only
- Uses `hidraw` device access for input
- Prioritizes a small public API over CLI behavior

## Public API Expectations

When changing the library, keep these entry points stable unless there is a strong reason to introduce a breaking change:

- `MicrosoftPresenter.connect()`
- `discoverPresenter()`
- `listPresenters()`
- `openPresenter()`

## Documentation Expectations

- Keep `README.md` in English
- Document Linux-only behavior clearly
- Call out runtime permissions such as access to `/dev/hidraw*`
- Update examples whenever the public API changes

## Implementation Notes

- Discovery logic lives in `src/hidDiscovery.ts`
- Public library exports live in `src/index.ts`
- Do not reintroduce `process.exit()` or CLI-only behavior into the library entry point

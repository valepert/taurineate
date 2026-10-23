# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

taurineate is a native macOS/Linux app (Tauri 2) inspired by [Delineate](http://delineate.sourceforge.net), the Java Swing GUI for raster-to-vector conversion. It keeps Delineate's UX and runs potrace and autotrace as separate binaries (Homebrew: `brew install potrace autotrace`). It's a standalone project: don't depend on files from other repos; anything it needs lives here.

## Commands

- Dev: `npm install && npm run tauri dev` (an `.npmrc` sets `legacy-peer-deps` because npm 10 crashes resolving Vite 8's peer deps). `npm run dev` starts only Vite, which can't reach the Tauri backend.
- Bundle: `npm run tauri build`
- Rust tests: `cd src-tauri && cargo test`; a single test: `cargo test pbm_header_and_bits`. `trace::tests::traces_with_installed_binaries` runs the real tracers and skips missing ones.
- Type-check the frontend: `npx tsc --noEmit`

## Architecture

- `src-tauri/tracers/{potrace,autotrace}.json` are the option descriptors, ported from Delineate's `settings/parameters-*.xml`. Both the settings UI (`src/settings.ts`) and the CLI flags (`tracers.rs::build_args`) are generated from them, so adding an option means editing only the JSON. Optional options have an enable checkbox. Disabled optional options and unchecked bools are left out of the argv.
- `raster.rs`: potrace gets a PBM on stdin, thresholded in-app by the "Brightness threshold" (as Delineate did with JIU), not via `--blacklevel`. AutoTrace gets a temp `.ppm`, because it picks its reader by file extension.
- `trace.rs::Runner` allows one tracer process at a time. A generation number is claimed before spawning, and a new trace kills the old process, which then returns the `"cancelled"` error that the frontend ignores.
- The `trace` command is used for both live preview (in memory) and Run (`output` set, so it writes the file).
- Tracer discovery (`discover.rs::resolve`): chosen path (`config.json`) → `TAURINEATE_<ENGINE>` env var → `PATH` → `STANDARD_DIRS` → login shell `PATH` (`$SHELL -ilc`, cached in a `OnceLock`, last resort because it costs ~0.5 s). Each candidate must pass `check` (`--version` names the program). Results are cached in `AppState.tracers` and refreshed by `detect_tracers`/`set_tracer_path`, so traces don't re-run `--version`.
- Tracer path overrides (`config.json`) and presets (`presets.json`) live in Tauri's `app_config_dir()`, not `./settings` like Delineate.
- Frontend is vanilla TS: `main.ts` (state and wiring; `state.view` switches the side panel between an engine and the Programs tab), `programs.ts` (tracer paths; the single ⚠ on the Programs tab comes from `hasProblem`, i.e. a missing program — skipped paths/env vars are only noted on the card; search order and env vars are documented in the README, not in the UI), `viewer.ts` (stacked Current/Previous panes with synced zoom/pan and a right-click menu), `settings.ts` (option grid and color popover).

## Conventions

- License is GPL-2.0-or-later (`LICENSE`, plus the `license` field in `Cargo.toml` and `package.json`). Credits for Delineate, potrace, AutoTrace and the sample images are in the README's "License and credits" section; keep it updated when adding third-party material.
- `docs/samples/` holds the scikit-image test images (`astronaut.png` public domain, `horse.png` CC0). `docs/screenshots/` are window-only captures (`screencapture -o -l <window id>`) with the samples opened from a neutral path such as `/Users/Shared/taurineate/`, so no personal paths show in the input/output fields.

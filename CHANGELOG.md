# Changelog

All notable changes to Bring are documented here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) once published. Until the
first npm release everything accumulates under **Unreleased** with the commit
that introduced it.

## [Unreleased]

### Added

- The full-screen Workspaces interface (Phase 1F): `bring` (or
  `bring workspaces`) now opens an alternate-screen TUI listing every known
  workspace with live status symbols, a detail pane (metadata, ports,
  contextual actions), and the whole lifecycle on single keys — `u`/`d`
  up/down, `r` rebuild, `e` shell (the TUI suspends while the shell owns the
  terminal, then repaints), `L` latest log with scrolling, `x` remove behind
  an explicit confirmation that source files stay. Vim keys and arrows both
  work; `?` shows help. Wide terminals get two panes, narrow ones a
  list/detail flow, and below 60×18 Bring points at the direct commands
  instead of rendering a broken screen. A failing `bring doctor` check blocks
  the TUI with the diagnostics and a retry key rather than letting
  operations fail confusingly later. Running `bring` without an interactive
  terminal explains itself and exits with a usage error.

### Fixed

- CI lint failures (masked locally by piping lint output through `tail`,
  which hides exit codes — lesson learned). (`fff5c59`)
- A workspace with both `.devcontainer/devcontainer.json` and
  `.devcontainer.json` demanded `--config` on *every* command. Bring now
  remembers the choice after one successful `bring up --config …` and
  announces which config it is using; explicit `--config` always overrides
  (spec amendment A5). The resolved config is also now always passed to the
  upstream CLI so it cannot silently pick the other file. (`1c1ad94`)

### Added

- Direct lifecycle commands, end to end: `bring [target] up | down | rebuild |
  shell | logs | status | remove` with `.`/`this`/path targets, nearest-
  ancestor config discovery, ambiguity errors instead of guessing, `stop` as
  a `down` alias, `-- <cmd>` passthrough for shell, and `--config` for
  explicit configurations. Interactive runs get a compact animated spinner
  line; pipes get plain stage lines; `--verbose` streams the underlying
  devcontainer output; `--json` emits exactly one schema-v1 document.
  `remove` asks for confirmation (or takes `--yes`) and never touches source
  files. (`c5d10f1`, `4a5ca37`, `a27d2ac`, `3ca4991`)
- `bring ls` — list every workspace Bring has used, with live status from
  Docker, most recent first (spec amendment A3). (`3ca4991`)
- Under the hood for the above: safe process runner (argv arrays, no shell,
  Ctrl+C forwarding), label-based Docker adapter (amendment A1 made
  devcontainer lifecycle impossible upstream), per-workspace operation locks,
  private rotating operation logs (`bring logs`, `--clear`), and a workspace
  registry at `~/.local/state/bring/state.json`. (`c5d10f1`–`3ca4991`)

- Colored `bring doctor` output in interactive terminals: green ✓, red ✗,
  dimmed skipped checks. Automatically plain when piped, under `NO_COLOR`, or
  with `--json`. A live animated checklist is planned for Phase 1E, when the
  Ink spinner components exist to reuse.
- `bring doctor` — non-mutating dependency diagnostics: locates the
  `devcontainer` and `docker` executables on PATH, probes them with bounded
  timeouts, verifies the Dev Containers CLI exposes the commands Bring needs
  (`up`, `exec`, `read-configuration`), and distinguishes a missing CLI, a
  capability gap, missing Docker, a stopped daemon, and a permission problem —
  each with the exact fix. Exit 0 when healthy, 4 when not. (`36c9271`)
- `bring doctor --json` — the same report as machine-readable JSON with stable
  check ids and error codes (`DEPENDENCY_MISSING`, `DEPENDENCY_UNREACHABLE`,
  `UNSUPPORTED_CAPABILITY`), never any ANSI. (`36c9271`)
- Installable CLI skeleton: `bring --version`, `bring --help`, bare `bring`
  Ink placeholder, contractual exit codes (0/1/2/3/4/5/130), unknown options
  rejected with exit 2, tests (vitest + ink-testing-library), Biome
  lint/format, GitHub Actions CI on Node 22 and 24, Apache-2.0 license,
  `npm pack` ships only `dist/` + metadata. (`122277c`)

### Changed

- Help and README now describe `bring down` / `bring remove` as acting like
  `docker stop` / `docker rm`: the upstream devcontainer CLI turned out to
  have no lifecycle stop/down commands at all, so Bring will manage workspace
  containers through Docker using devcontainer labels (product semantics
  unchanged: `down` preserves, `remove` deletes). (`36c9271`)

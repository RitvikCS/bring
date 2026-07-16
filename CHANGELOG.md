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
  terminal explains itself and exits with a usage error. (`e2d8479`)

- `--dotfiles <repo-url>` on `up` and `rebuild`: applies the dotfiles repo
  via the upstream `--dotfiles-repository` flag and remembers it after one
  success, so later ups (CLI and TUI alike) apply it automatically.
  `--dotfiles none` skips a single run; a new URL replaces the remembered
  one (spec amendment A6). (`a6a56ad`)
- README quickstart (Phase 1G, P1-48): install → doctor → first `up` →
  shell → TUI walkthrough, plus what counts as a configured project and a
  one-paragraph tour of the TUI. The Phase 1 exit gate was scripted and
  run against the installed release candidate: 28/28 checks pass,
  including missing-dependency diagnosis without stack traces, the full
  lifecycle on a path with spaces reached through a symlink, single-
  document `--json`, and ANSI-free piped output. (P1-49)
- Integration fixtures and a gated real-lifecycle test suite (Phase 1G,
  P1-44/45/46): three tiny devcontainer projects under `fixtures/` (minimal
  image, Docker Compose, deliberately failing `postCreateCommand`) and
  `npm run test:integration`, which copies each to a temp directory and
  drives up → idempotent up → exec → down → remove through the real Dev
  Containers CLI and Docker, asserting source files stay untouched and the
  failure case produces a concise problem plus a full captured log. Skipped
  unless `BRING_INTEGRATION=1`.
- First-contact affordance in the TUI: opening `bring` inside a project
  that has a devcontainer config but was never brought up now lists that
  folder (marked "this folder") instead of an empty screen — press `u` and
  it becomes a normal registered workspace. A frame-geometry regression
  test also guards that no TUI line can exceed the terminal width or lose
  its right border, at any size. (`5660ac8`)

### Changed

- `r` (rebuild) in the TUI now asks for confirmation, exactly like remove:
  a rebuild deletes the container and rebuilds it from scratch, which is too
  expensive an action for a stray keystroke. All other action keys stay
  single-press — an accidental `u` is a no-op, `d` is undone by one `u`,
  and a shell is one Ctrl-D away.
- The workspace detail pane now shows what you would otherwise run commands
  for: the container's age straight from Docker ("Up 2 hours" /
  "Exited (0) 3 days ago"), when the workspace was last used, and the tail
  of the latest operation log (with `L` still opening the full view).
- First hand-testing polish round for the TUI and direct output: the list
  pane no longer changes width between states (long values truncate instead
  of squeezing the layout), the TUI refreshes every 3 seconds while idle so
  changes made from another terminal show up, key hints render with the key
  in the accent color instead of a flat dim string, the detail pane and
  `bring status` show the remembered dotfiles default, `bring ls` and
  `bring status` gained status symbols and color, the remembered-config
  note shrank to one dim line, and entering a shell prints how to get back.

### Fixed

- Keystrokes typed into an already-closed shell could leak into the TUI as
  commands — `exit⏎` typed after bash had quietly exited (Ctrl+D at an
  empty prompt) arrived as `e`/`x`/`i`/`t`/Enter, where `x` opens the
  remove confirmation and Enter was one buffered keypress from confirming
  it. The TUI now ignores input for a short window after a shell returns,
  and confirmation modals ignore Enter for their first instants so a
  buffered keypress can never insta-confirm a destructive action. The
  return from a shell also announces itself: "Shell in X closed — back in
  Bring."
- Resizing could leave the TUI blank (most visibly around the too-small
  threshold): the old repaint-on-resize called `instance.clear()`, which
  erases the screen but tells the incremental renderer the old frame is
  still there — an unchanged next frame then wrote nothing. Resizes now
  trigger a debounced full redraw through Ink's suspend cycle, which also
  cures the stale-cell fragments.
- The unfocused pane's border looked missing (the "open right border"
  reports): it was colored ANSI gray/bright-black, which is invisible on
  dark or transparent terminal themes. Unfocused borders now dim the
  default foreground color, which is visible on any theme.
- The frame's right border could still vanish in floating windows whose
  pixel width is not an exact multiple of the cell width — the terminal
  leaves a partial, never-rendered final column (ghostty; fullscreen
  snaps to exact multiples, which is why it "came back" there). The TUI
  now reserves the last column and never draws into it.
- The detail pane's log tail no longer shows bare `[timestamp]` lines or
  the trailing `{"outcome":…}` result JSON — it skips to the last lines
  that say what actually happened.
- `Ctrl+H` (focus the list pane) never worked: terminals send Ctrl+H as the
  ASCII backspace character, so it arrived as a backspace keypress with the
  ctrl flag unset and the binding never fired. Backspace now focuses the
  list pane, which makes Ctrl+H work everywhere (`Ctrl+L` was unaffected).
- Leaving a long shell session whose last in-container command had failed
  with 126/127 (e.g. a typo'd command right before `exit`) was misreported
  as "`bash` is not available" — the missing-command hint now only applies
  when the shell dies within its first ten seconds.
- Resizing the TUI could leave fragments of old borders floating in blank
  areas (stale cells under incremental rendering) — the screen now repaints
  from scratch after a resize. Log lines are also sanitized (ANSI codes,
  tabs) before display.
- Entering a workspace shell is now unmistakable: `bring shell` and the
  TUI's `e` print an accent-colored boundary line on entry (and the direct
  command on return), instead of dropping you into a prompt that can look
  identical to the host's.

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

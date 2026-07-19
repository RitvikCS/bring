# Changelog

All notable changes to Bring are documented here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.2] - 2026-07-19

### Changed

- `npm pack`/`npm publish` now always rebuild first (`prepack` hook). A
  stale `dist/` previously shipped silently in locally packed tarballs.

### Fixed

- Ctrl-modified keys no longer act as their plain letters in the TUI:
  Ctrl+D read as `d` and stopped the selected workspace without asking,
  Ctrl+X as `x` opened the remove confirmation. Only Bring's real Ctrl
  chords (Ctrl+H/Ctrl+L pane focus) act; every other Ctrl combination is
  now inert.

## [0.2.1] - 2026-07-19

### Changed

- Shells no longer show Docker Desktop's "What's next: Try Docker Debug…"
  hint on exit (`DOCKER_CLI_HINTS=false` is set for interactive shell
  sessions only).

### Fixed

- Shells opened from the TUI no longer race the suspended TUI for keyboard
  input. Bring now stops reading the terminal entirely while a shell owns it
  and discards anything it captured before and after, so keystrokes cannot
  leak into the shell, vanish from it, or replay as TUI commands after it
  exits. On macOS this replay could reopen the shell or trigger the remove
  confirmation from a typed `exit`; a stolen Ctrl+D EOF also left the shell
  waiting for an extra Enter.

## [0.2.0] - 2026-07-18

### Added

- Phase 2 resource inventory foundation: Bring now identifies Dev Container
  containers from upstream workspace labels, relates Docker Compose sidecars
  through their project labels, and discovers images through the upstream
  `devcontainer.metadata` label. Inventory uses exact image IDs and byte sizes,
  records container/image/workspace impact, and never guesses from resource
  names. Image use includes every Docker container so later cleanup cannot
  mistake a shared image for an unused one.
- The Containers section is now live: it shows only positively related Dev
  Container primaries and Compose sidecars, keeps selection stable across
  refreshes, and provides responsive list/detail views with status, workspace,
  image, age, role, service, ports, and exact container ID. The TUI now loads
  every pane from one coordinated Docker inventory instead of querying Docker
  once per remembered workspace.
- Container actions are connected: `e` opens a shell in the exact selected
  primary or Compose service through `devcontainer exec --container-id`, `d`
  stops only that container, and `x` opens a confirmation before stopping and
  removing it. Mutations share the workspace operation lock, never force
  removal, and explicitly preserve images, volumes, and source files.
- The Images section now shows exact sizes, creation age, tags, dangling state,
  every container use, and related workspace impact for positively identified
  Dev Container images. `Space` marks removable images, `x` confirms one
  selected batch by name, and `p` stages safely prunable dangling Dev Container
  images for the same review. Attached images cannot be selected, removal never
  uses `--force`, and `--no-prune` prevents Docker from silently deleting
  unselected parent images.
  Recovery is deliberately described as an upper bound because layers may be
  shared.
- `/` now opens a live smart-case filter in Containers and Images, with
  match/total counts, Enter to keep the query, Esc to cancel while editing,
  and Esc from the filtered list to clear it. Number keys `1`–`4` now jump to
  the numbered top-level sections and Tab cycles list/detail focus, alongside
  the existing Vim, arrow, and Ctrl+H/Ctrl+L navigation.

### Fixed

- Workspace status, down, and remove now include Docker Compose sidecars,
  rather than acting only on the primary container carrying the upstream
  workspace label. Registered Compose working-directory labels preserve the
  relationship even if the primary disappeared first; real integration
  coverage asserts that no app or sidecar survives removal.
- Image cleanup now distinguishes an exact container attachment from a cached
  base-image relationship by comparing inspected Docker layer chains. Cached
  bases show their descendant containers and workspace impact instead of being
  called unused. `p` stages only unattached, non-ancestor dangling images;
  cached bases and unused tagged images require explicit selection, and their
  confirmation warns that a future rebuild may pull or build them again.
- Tag-triggered npm publishing: pushing a `v*` tag runs the full check suite
  and publishes via npm trusted publishing (OIDC) — no stored tokens, with
  provenance attestations generated automatically. The workflow refuses to
  publish when the tag and `package.json` version disagree.
- Action keys are now scoped to the section on screen: `u`/`d`/`e`/`L` in the
  Containers or Images section could previously act on the workspace still
  selected in the hidden Workspaces pane — `d` while reviewing images would
  bring down a dev environment that was not even visible. Every action key is
  now dead outside the sections whose pane can show its target, enforced in
  the keymap and double-checked in the command executor.
- A Compose project's registered working directory can no longer override the
  upstream workspace label when relating sidecars: a compose file living
  under a different registered workspace than the devcontainer it serves had
  its sidecars filed under the wrong workspace, where `bring down`/`remove`
  on that workspace would have stopped or deleted another project's
  containers.
- One container or image vanishing between the inventory's list and inspect
  calls (a `--rm` container exiting, a parallel removal) no longer fails the
  whole inventory — and with it every `bring up`/`down`/`status` on the
  machine. Surviving inspect data is kept; missing entries fall back to their
  listing row.
- Refreshes that skip image inspection (the idle poll, section switches) no
  longer wipe the Images list and the Space-marked removal batch; a staged
  batch now survives glancing at another section. A transient inventory
  failure also keeps the previous image state instead of showing a false
  empty list.
- A refresh requested while another was in flight (finishing a container
  stop/remove while the idle poll was running) was silently dropped, leaving
  removed containers on screen until the next poll tick; it is now queued and
  runs as soon as the in-flight pass lands.
- Digest-pinned images (`"image": "repo@sha256:…"`) were classified as
  dangling — `p` staged a deliberately pinned base image as "safely
  prunable". Pinned digests now count as references, and such images display
  their digest instead of `<none>:<none>`.
- Paused and restarting containers were treated as already stopped: `d`
  reported success without touching Docker and `x` failed on the forceless
  `docker rm`. Both now stop the container for real first.
- Multi-tagged images could never be removed (Docker refuses a forceless
  removal by id when several repositories reference the image); tagged images
  are now removed by untagging each reference, still without `--force`.
- Image removal now takes the impacted workspaces' operation locks, so it
  refuses to race a concurrent `bring up` that may be about to use the image,
  exactly like container mutations always did.
- `bring ls` now reads the same coordinated inventory as `bring status` and
  the TUI, so the three can no longer disagree about a Compose workspace
  whose sidecars outlive its primary — and `ls` issues one Docker query
  instead of one per workspace. All three also share one snapshot reduction,
  which fixes `bring status` showing a sidecar's uptime instead of the
  primary's.

## [0.1.0] - 2026-07-16

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

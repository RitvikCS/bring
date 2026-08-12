# Bring command reference

Everything the `bring` binary can do, in one page. `bring --help` shows the
short version of this; inside the TUI, `?` shows the keyboard reference.

```
bring [target] <action> [options]   # one operation, directly
bring <global-command>              # doctor · ls
bring [section]                     # the full-screen interface
```

## Targets

Every action takes an optional target before it:

| Target | Meaning |
| ------ | ------- |
| *(nothing)* or `.` or `this` | the current directory — `bring this up` reads the way it sounds |
| `<path>` | any other project, relative or absolute: `bring ../api down` |

Bring looks for the nearest devcontainer configuration **upward** from the
target (`.devcontainer/devcontainer.json` or `.devcontainer.json`, the same
rules as VS Code), so running from a subdirectory works. After the first
successful `up`, Bring remembers the project — from then on it shows up in
`bring ls` and the TUI from anywhere.

## Actions

### `bring up`

Creates and starts the dev container for the workspace (running
`devcontainer up` under the hood). Idempotent: if the environment is already
running it says so and exits successfully. A stopped container is restarted
in about a second; a missing one is built from the config.

Options: `--config <path>` (explicit devcontainer.json, remembered for next
time), `--dotfiles <repo|none>` and `--profile <name|none>` (see
[Dotfiles](#dotfiles)), `--verbose`, `--json`.

### `bring down`

Stops the workspace's containers — **including Docker Compose sidecars** —
but keeps them, so the next `up` is a fast restart. Acts like `docker stop`.

### `bring rebuild`

Rebuilds the environment from the configuration
(`--remove-existing-container` under the hood). `--no-cache` also bypasses
the Docker build cache. Use after editing `devcontainer.json`.

### `bring shell`

Opens an interactive shell inside the running container (default `bash`).
`exit` or Ctrl-D returns to your terminal. Override the command after `--`:

```sh
bring shell            # bash
bring . shell -- zsh   # zsh instead
bring shell -- python3 # any command, interactively
```

The shell's exit code passes through, so scripting against it works. The
workspace must be running (`bring up` first).

### `bring status`

One workspace's live summary: status, containers, image, config, ports.
`--json` makes it scriptable.

### `bring logs`

Prints the captured output of the workspace's last operation (each `up`,
`rebuild`, `down`, `remove` is recorded; the previous one is kept too).
`--clear` deletes the stored logs.

### `bring remove`

Stops and **deletes** the workspace's devcontainer resources — containers
(including Compose sidecars). Acts like `docker rm`. Asks for confirmation
first and never touches source files; `--yes`/`-y` skips the prompt for
scripts.

## Global commands

### `bring doctor`

Checks the ground Bring stands on: Node, the Dev Containers CLI, and
Docker — and explains exactly what is missing and how to fix it. The Dev
Containers CLI is bundled with Bring; a system-wide `devcontainer` on your
PATH is preferred when present, and doctor's detail line says which copy is
in use. The TUI
runs the same checks on startup and shows the diagnosis instead of letting
operations fail confusingly later.

### `bring ls`

Every project Bring knows, with live status (`running`, `stopped`,
`not created`, `missing-config`) and its path. One Docker query for the
whole list.

### `bring forget <workspace>`

Drops a workspace from Bring's registry — by name from `bring ls` or by
path, even when the directory no longer exists. Containers, images, and
source files are untouched; the workspace's captured operation logs are
cleared with it. An ambiguous name lists the matching paths and asks for
the full one.

## The full-screen interface

Bare `bring` opens the TUI; `bring workspaces`, `bring containers`,
`bring images`, or `bring profiles` opens it on a specific section.

| Key | Does |
| --- | ---- |
| `j`/`k` or arrows | move the selection |
| `h`/`l` or `1`–`4` | switch section (Workspaces · Containers · Images · Profiles) |
| `Tab`, `Ctrl+H`/`Ctrl+L` | move focus between list and detail panes |
| `Enter` | open detail / primary action (starts a stopped workspace) |
| `u` / `d` / `r` | up / down / rebuild the selected workspace |
| `e` | shell into the selected workspace or container |
| `L` | view the captured operation log (`j`/`k`/`g`/`G` scroll) |
| `x` | request removal — always lands in a confirmation first |
| `/` | filter the Containers/Images list (smart-case), `Esc` clears |
| `Space`, `p` | Images: mark an image / review prunable dangling images |
| `n` / `e` / `s` / `a` | Profiles: new / edit / toggle default / assign to a workspace |
| `?` | keyboard help |
| `q` / `Esc` | quit / back |

Safety rules the TUI never breaks: destructive actions always confirm, image
removal is never forced, attached images can't be selected, and source files
are never touched.

## Dotfiles

Dotfiles ride the Dev Containers CLI's own mechanism: the repo is cloned
into the container and its install script runs when the container is
**created** (an existing container keeps its state until a `rebuild`). The
container image needs `git` for the clone — slim images often lack it; the
devcontainers base images all have it.

### Profiles

The full mechanism is **named profiles**, managed in the TUI
(`bring profiles`): each profile is a repository plus an optional install
command and target path. Which profile applies to an `up`/`rebuild` follows
a strict precedence:

```
--profile <name>  >  workspace assignment  >  default profile
                  >  the only profile      >  no Bring dotfiles
```

- With several profiles and no default, interactive runs ask; scripts must
  pass `--profile <name>` (or `none`).
- `--profile none` skips Bring dotfiles for one run.
- **First use of a profile shows its repository and install command and asks
  before running** (`--yes` accepts in scripts). Editing a profile re-arms
  that confirmation.
- Profiles live in `~/.config/bring/config.json`
  (`$XDG_CONFIG_HOME/bring/config.json`) — plain JSON, safe to hand-edit; a
  config Bring cannot parse fails loudly instead of being ignored.
- No profile command ever executes on the host, and your project's
  `devcontainer.json` is never modified.

### The quick way

`bring up --dotfiles <repo-url>` still works without any profiles: after one
successful use the URL is remembered as your user default and applied
automatically; `--dotfiles none` skips it once. The first time profiles are
loaded, an existing remembered URL is migrated into a `default` profile
automatically.

## Options (all commands)

| Option | Effect |
| ------ | ------ |
| `--json` | machine-readable output, never animated |
| `--verbose` | stream the underlying devcontainer/docker output live |
| `--config <path>` | use an explicit devcontainer.json (remembered) |
| `--yes`, `-y` | skip the `remove` confirmation |
| `--no-cache` | rebuild without the Docker build cache |
| `--dotfiles <repo\|none>` | dotfiles repo for up/rebuild (remembered) |
| `--profile <name\|none>` | dotfiles profile for up/rebuild (see Profiles) |
| `--help`, `-h` / `--version`, `-v` | help / version |

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success (or a cancelled confirmation — nothing was mutated) |
| 1 | a Dev Container or Docker operation failed |
| 2 | invalid usage or unknown option |
| 3 | workspace/configuration resolution failed |
| 4 | a required dependency is missing or unreachable (`bring doctor`) |
| 5 | internal Bring error |
| 130 | interrupted with Ctrl+C |

## Update notifications

Bring checks the npm registry for a newer version at most once a day, in a
detached background process — no command ever waits on the network. When a
newer version is cached, a dim one-liner appears on stderr after a command
(never in `--json` output, pipes, or scripts):

```
Update available 0.2.3 → 0.3.0 · npm install -g @ritvikcs/bring
```

Set `BRING_NO_UPDATE_CHECK=1` to disable the check entirely.

## Where state lives

State is under `~/.local/state/bring/` (or `$XDG_STATE_HOME/bring`):
`state.json` (workspace registry, dotfiles default, profile first-use
confirmations — plain JSON, safe to hand-edit), `logs/` (captured operation
output), `locks/` (transient operation locks). Bring never stores anything
inside your projects, and a deleted/corrupt state file is never an error —
it just starts fresh.

Configuration — your dotfiles profiles — is separate, under
`~/.config/bring/config.json` (or `$XDG_CONFIG_HOME/bring/config.json`),
because it is intent you author rather than memory Bring keeps. Unlike
state, a broken config file is reported loudly, never silently discarded.

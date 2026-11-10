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

### `bring exec`

Runs one command inside the running container without taking over your
terminal — for scripts, CI steps, and coding agents. Everything after `--`
is the command, passed as-is (no shell; use `-- sh -c '…'` for pipes):

```sh
bring exec -- npm test
bring ../api exec --timeout 300 -- pytest -x
bring exec --json -- sh -c 'cat package.json | head -5'
```

- The command's stdout and stderr stream live to yours; Bring's one-line
  summary goes to **stderr**, so `bring exec -- cat out.json > out.json`
  gives you exactly the file.
- **Exit code**: when the command ran, Bring exits with *the command's own*
  exit code, so `bring exec -- npm test && deploy` works. When Bring could
  not run it (workspace not running, Docker down), Bring's own codes
  apply. A command that itself exits 3 therefore looks like a resolution
  failure; if you must tell them apart, use `--json` and read `outcome` /
  `error.code` vs `exitCode`.
- `--timeout <seconds>` stops the command — and everything it started
  inside the container — and exits **124**.
- Ctrl+C stops the command inside the container too (exit 130). Plain
  `docker exec`/`devcontainer exec` leave it running.
- No TTY and no stdin: use `bring shell -- <cmd>` for anything interactive.
- The workspace must be running; `exec` never starts it.
- The full output of each run is saved under Bring's state directory
  (`logs/<workspace>/exec/`, last 20 kept) and its path is printed on
  failure. `bring logs` keeps showing the last `up`/`rebuild` log.

`--json` prints one document instead of streaming:

```jsonc
{
  "schemaVersion": 1, "operation": "exec",
  "outcome": "success",            // Bring ran it: success | failed | interrupted
  "workspace": "/abs/path", "workspaceName": "api",
  "durationMs": 4210, "containerIds": ["…"],
  "message": "npm test exited with code 1",
  "command": ["npm", "test"],
  "exitCode": 1,                   // the command's code (absent if it never ran)
  "stdout": "…", "stderr": "…",    // last 16 KiB of each
  "truncated": { "stdout": false, "stderr": true },
  "logPath": "…/exec/….log",
  "error": { "code": "COMMAND_TIMEOUT", "summary": "…" }  // only on failure
}
```

#### `--detach`: servers

`bring exec --detach -- npm run dev` starts the command in the background
inside the container and returns at once with its pid, where its output
goes, and the exact command that stops it (and every child it spawned):

```
✓ started npm run dev in api (pid 559)
  Output: bring . exec -- tail -n 100 /tmp/bring-detached-3f2a….log
  Stop:   bring . exec -- kill -15 -559
```

With `--json` the same appears as `pid`, `containerLogPath`, `tailCommand`,
`stopCommand`, and `warnings`. Bring does not keep track of detached
processes; `bring down` stops everything anyway. To open the server from
your machine, see `bring forward`.

### `bring forward`

Makes a server running inside the container reachable from your machine —
a Vite or FastAPI dev server, a database, a debugger port — until you
press Ctrl+C:

```sh
bring forward                # every port in devcontainer.json "forwardPorts"
bring forward 5173           # http://localhost:5173 → port 5173 in the container
bring forward 8080:3000      # your port 8080 → the container's port 3000
bring forward db:5432        # a Compose service, by its service name
bring forward 15432:db:5432  # …on a different local port
```

```
✓ localhost:5173 → 5173
Forwarding into api via bash (only this machine can connect) — Ctrl+C to stop.
```

Why this exists: the Dev Containers CLI ignores `forwardPorts` (only VS Code
honours it), and the alternative, `appPort`, needs an edit to
devcontainer.json, a rebuild, and a server that listens on `0.0.0.0`.
`bring forward` needs none of that: it works with servers that listen only
on `localhost` inside the container (Vite's default), and changes nothing in
your project or container.

- It listens on `127.0.0.1` only — other machines on your network cannot
  connect.
- It runs in the foreground, like VS Code's forwarding while a window is
  connected. Keep it in its own terminal tab. There is no background mode.
- The workspace must be running. If nothing is listening on a port yet, the
  forwarder says so and keeps going — start the server whenever.
- After a `bring rebuild`, it finds the new container by itself.
- If a local port is taken, that port is skipped with a suggestion
  (`bring forward 5174:5173`); the others keep working.
- It needs one of `bash`, `node`, or `socat` inside the container (checked
  in that order). Nearly every dev container image has bash; on a bare
  Alpine image add it (`apk add bash`).
- Each new connection costs roughly 0.1 s to set up; data then flows at
  full speed. Pages that open many connections at once load a little slower
  than through a published port.
- Not supported: `--json`, UDP, and the labels in `portsAttributes`.

Starting the server from a script or agent? Pair it with
`bring exec --detach -- npm run dev`.

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
the full one. In the TUI, `f` on a selected workspace does the same thing
behind a confirmation.

`--json` prints `{operation: "forget", outcome, workspace, workspaceName,
message}` (or an `error`), with the same exit codes.

### `bring containers --json` / `bring images --json`

Without `--json` these open the TUI sections. With it they print the same
inventory as one JSON document — what scripts and agents need to explain
disk use without being able to change anything:

- `containers`: `id`, `name`, `state`, `statusText`, `createdAt`, `imageId`,
  `imageName`, `ports`, `workspacePath`, `workspaceName`, `role`
  (`primary` | `service`), `serviceName` (Compose services).
- `images`: `id`, `displayName`, `references`, `createdAt`, `sizeBytes`,
  `dangling`, `usage` (`attached` | `base` | `unused`), `pruneCandidate`,
  `containerNames`, `descendantContainerNames`, `workspacePaths`,
  `workspaceNames`.

### `bring images prune`

Removes exactly what the TUI's `p` selects: Dev Container images that are
**unused and unnamed** (dangling — typically left over from an old rebuild).
Cached base images, named images, and pinned (digest-only) images are never
picked; remove those one by one in the TUI. Attached images can never be
removed, and Docker gets no `--force`.

```sh
bring images prune --dry-run   # list them and the most space it could free
bring images prune             # list, then ask (terminal only)
bring images prune --yes       # scripts: no prompt
```

Without `--yes` and without a terminal it changes nothing and exits 2.
`--json` reports `candidates`, `upToBytes`, and `removedIds`. The size is an
upper bound: layers shared with other images are not freed. With Docker's
containerd image store (on by default in a fresh Docker Engine 29 install),
a rebuild did not leave the replaced image behind in our testing, so there
is often nothing to prune; the classic store does leave them.

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
| `f` | forget the selected workspace (registry only, confirms first) |
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
| `--events` | up/rebuild/down/remove: progress as JSON lines (see below) |
| `--config <path>` | use an explicit devcontainer.json (remembered) |
| `--yes`, `-y` | skip the `remove` / `images prune` confirmation |
| `--dry-run` | `images prune`: show what would be removed, change nothing |
| `--no-cache` | rebuild without the Docker build cache |
| `--timeout <seconds>` | exec: stop the command after N seconds (exit 124) |
| `--detach` | exec: start in the background, print pid and stop command |
| `--dotfiles <repo\|none>` | dotfiles repo for up/rebuild (remembered) |
| `--profile <name\|none>` | dotfiles profile for up/rebuild (see Profiles) |
| `--help`, `-h` / `--version`, `-v` | help / version |

## Progress for programs: `--events`

`--json` stays silent until the operation ends — fine for `status`, but a
`bring up` that builds an image can take minutes. `--events` prints each
step as it happens, one JSON object per line (NDJSON) on stdout:

```sh
bring up --events
```

```
{"schemaVersion":1,"type":"started","operation":"up","workspaceName":"api"}
{"schemaVersion":1,"type":"stage","stage":"building","message":"Building api…"}
{"schemaVersion":1,"type":"stage","stage":"ready","message":"api is ready"}
{"schemaVersion":1,"type":"completed","result":{"operation":"up","outcome":"success",…}}
```

- Stages: `validating`, `reading-config`, `building`, `creating`, `starting`,
  `running-hooks`, `stopping`, `removing`, `ready`.
- The last line is always `type: "completed"`, and its `result` is exactly
  what `--json` would print. Wait for it; its `outcome` and the exit code
  tell you how it went. A target that cannot be resolved still produces a
  single `completed` line.
- With `--verbose`, raw build output arrives as `type: "output"` lines
  (`stream`, `chunk`). Without it they are left out — build logs are big.
- Like `--json`, it never prompts: `remove` needs `--yes`, and a dotfiles
  profile choice must be made with `--profile`.
- Not combinable with `--json`. Only for `up`, `rebuild`, `down`, `remove`.

Coding agents that run `bring up` in the background can read this stream to
tell "still building" from "stuck".

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success (or a cancelled confirmation — nothing was mutated) |
| 1 | a Dev Container or Docker operation failed |
| 2 | invalid usage or unknown option |
| 3 | workspace/configuration resolution failed |
| 4 | a required dependency is missing or unreachable (`bring doctor`) |
| 5 | internal Bring error |
| 124 | `bring exec --timeout` stopped the command |
| 130 | interrupted with Ctrl+C |

`bring exec` (and `bring shell`) exit with the command's own exit code when
the command ran; the table applies when Bring itself failed.

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

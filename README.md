# bring

A friendly terminal UI and command layer on top of the
[Dev Containers CLI](https://github.com/devcontainers/cli) — bring a dev
environment up, take it down, inspect it, and clean it up without remembering
the underlying `devcontainer` and `docker` syntax.

![bring demo — up, status, shell, and the full-screen interface](https://raw.githubusercontent.com/RitvikCS/bring/main/demo/bring-demo.gif)

```sh
bring this up        # yes, that works — `this` and `.` mean "this project"
bring up             # start the dev container for the current project
bring down           # stop it (containers kept for a fast restart)
bring shell          # open a shell inside it (bring shell -- zsh works too)
bring status         # what's running, which ports, which config
bring ls             # every project bring knows, with live status
bring containers     # inspect and act on Dev Container containers
bring images         # review Dev Container image usage and cleanup
bring . remove       # stop and DELETE devcontainer resources (asks first)
bring ../api up      # any action works on any path
bring doctor         # check that devcontainer CLI + Docker are ready
```

Every command also takes `--json` for scripting and `--verbose` for the raw
underlying output. The full reference — every command, TUI key, option, and
exit code — lives in [docs/commands.md](docs/commands.md).

> **Status: early development.** Direct commands and the full-screen
> Workspaces, Containers, and Images sections work end to end.

## Why

Devcontainer-savvy tools either live inside an editor (VS Code) or know
nothing about devcontainers (lazydocker). Bring is workspace-first: the
question is "which project do I want to work on?", not "which container ID do
I want to manipulate?". It never installs anything on your machine, never
deletes source files, and spawns every command without a shell.

The naming that matters most:

| Bring command  | Meaning         | Acts like     |
| -------------- | --------------- | ------------- |
| `bring down`   | stop, preserve  | `docker stop` |
| `bring remove` | stop and delete | `docker rm`   |

(The upstream `devcontainer` CLI has no lifecycle stop/remove commands at
all — Bring finds a workspace's containers through devcontainer labels and
manages them via Docker.)

## Requirements

- Node.js 22+
- [Dev Containers CLI](https://www.npmjs.com/package/@devcontainers/cli) (`npm i -g @devcontainers/cli`)
- Docker

Bring checks these at runtime (`bring doctor`) and explains what's missing —
it never installs them for you.

## Quickstart

```sh
# 1. Install
npm install -g @ritvikcs/bring

# 2. Check the ground under your feet
bring doctor         # verifies the devcontainer CLI and Docker, with fixes

# 3. In any project that has a devcontainer configuration
cd ~/code/my-project
bring up             # build + start (idempotent — safe to run again)
bring shell          # work inside; exit or Ctrl-D comes back out
bring down           # stop, keeping the container for a fast restart

# 4. Or drive everything from the full-screen UI
bring
```

### Any project, from anywhere — and your dotfiles ride along

![bring lifecycle — ls, path targets, remove confirmation, dotfiles shell](https://raw.githubusercontent.com/RitvikCS/bring/main/demo/bring-lifecycle.gif)

Actions take a path target (`bring ../api up`, `bring ~/code/etl down`), so
you never have to `cd` first. And `bring up --dotfiles <repo-url>` installs
your dotfiles into every container it creates — after one success the URL is
remembered as your user default, so future containers just come out looking
like home (`--dotfiles none` skips it once). Details in
[docs/commands.md](docs/commands.md#dotfiles).

A project counts as configured when it has
`.devcontainer/devcontainer.json` or `.devcontainer.json` — the same rules
as VS Code. Bring remembers a project after its first successful `up`, so
the TUI and `bring ls` show it from anywhere. Opening the TUI inside a
configured project that was never brought up lists it too, marked
"this folder".

### The TUI in one paragraph

`bring` opens an alternate-screen interface. Workspaces show lifecycle,
ports, config, and logs; Containers exposes only resources positively tied
to Dev Container workspaces (including Compose sidecars); Images exposes only
images carrying Dev Container metadata or used by those containers. `j`/`k`
or arrows select, `h`/`l` or `1`–`4` change sections, Tab changes pane focus,
and `/` filters resource lists. Workspace actions remain `u`, `d`, `e`, `r`,
`L`, and `x`. In Images, Space marks a removable image and `p` reviews safely
prunable dangling images; one confirmation shows the batch and an upper-bound
space estimate.
Attached images cannot be selected. Cached base and unused tagged images are
explicit opt-in selections; `p` only stages unattached, non-ancestor dangling
images. Image removal is never forced, and source files are never touched. `?`
shows every binding and `q` quits. If `bring
doctor` fails, the TUI shows the diagnosis instead of letting operations fail
confusingly later.

## Where Bring keeps its state

Everything lives under `~/.local/state/bring/` (or `$XDG_STATE_HOME/bring`
if you set it):

- `state.json` — the workspace registry: every project Bring has
  successfully brought up (path, last-used time, which config file you
  chose), plus `dotfilesRepository`, the user-wide dotfiles default set by
  `--dotfiles <url>`. It is plain JSON and safe to edit by hand — for
  example, delete the `dotfilesRepository` line to clear the dotfiles
  default, or remove a workspace entry to forget a project. A corrupt or
  deleted file is never an error; Bring just starts with an empty registry.
- `logs/<workspace-id>/` — the captured output of the latest (and previous)
  operation per workspace, shown by `bring logs`. Delete freely.
- `locks/` — transient per-workspace operation locks.

Bring never stores anything inside your project folders.

## Developing

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run build
npm pack && npm install -g ./ritvikcs-bring-*.tgz
```

`npm test` is hermetic (fake binaries, temp state). The real-lifecycle
suite — actual Dev Containers CLI, actual Docker, tiny fixture projects
under `fixtures/` — runs with `npm run test:integration`.

## License

[Apache-2.0](LICENSE)

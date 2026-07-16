# bring

A friendly terminal UI and command layer on top of the
[Dev Containers CLI](https://github.com/devcontainers/cli) — bring a dev
environment up, take it down, inspect it, and clean it up without remembering
the underlying `devcontainer` and `docker` syntax.

```sh
bring up             # start the dev container for the current project
bring down           # stop it (containers kept for a fast restart)
bring shell          # open a shell inside it (bring shell -- zsh works too)
bring status         # what's running, which ports, which config
bring ls             # every project bring knows, with live status
bring . remove       # stop and DELETE devcontainer resources (asks first)
bring ../api up      # any action works on any path
bring doctor         # check that devcontainer CLI + Docker are ready
```

Every command also takes `--json` for scripting and `--verbose` for the raw
underlying output.

> **Status: early development.** Direct commands and the full-screen
> Workspaces TUI (`bring` with no arguments) work end to end. Not yet
> published to npm — install from a clone for now (see Developing).

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
# 1. Install (from a clone, until the npm release)
git clone https://github.com/RitvikCS/Bring && cd Bring/bring
npm ci && npm run build && npm pack && npm install -g ./ritvikcs-bring-*.tgz

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

A project counts as configured when it has
`.devcontainer/devcontainer.json` or `.devcontainer.json` — the same rules
as VS Code. Bring remembers a project after its first successful `up`, so
the TUI and `bring ls` show it from anywhere. Opening the TUI inside a
configured project that was never brought up lists it too, marked
"this folder".

### The TUI in one paragraph

`bring` opens an alternate-screen interface: workspaces on the left,
detail (status, container age, ports, config, latest-log tail) on the
right. `j`/`k` or arrows select a workspace, `u`/`d` bring it up/down,
`e` opens a shell (the UI suspends, then repaints when you exit), `L`
shows the full latest log, `r` rebuilds and `x` removes — both behind an
explicit confirmation. `?` shows every binding, `q` quits. If `bring
doctor` would fail, the TUI shows the diagnosis instead of letting
operations fail confusingly later.

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

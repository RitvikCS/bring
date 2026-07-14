# bring

A friendly terminal UI and command layer on top of the
[Dev Containers CLI](https://github.com/devcontainers/cli) — bring a dev
environment up, take it down, inspect it, and clean it up without remembering
the underlying `devcontainer` and `docker` syntax.

```sh
bring            # full-screen TUI: your workspaces, their state, one-key actions
bring this up    # start the dev container for the current project
bring . down     # stop it (kept for a fast restart)
bring . shell    # open a shell inside it
bring . remove   # stop and delete devcontainer resources (never source files)
```

> **Status: early development.** The CLI installs and runs (`--version`,
> `--help`, `bring doctor`), but lifecycle commands and the TUI are still
> being built. Not yet published to npm.

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

## Developing

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run build
npm pack && npm install -g ./ritvikcs-bring-*.tgz
```

## License

[Apache-2.0](LICENSE)

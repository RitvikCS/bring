import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake-executable harness (spec §17.2): tests drop shell scripts named
// `devcontainer`/`docker` into a temp dir and hand that dir to Bring as PATH,
// so real spawning is exercised without real dependencies. Keep the scripts
// to shell builtins (echo, case, exit) — the fake PATH contains nothing else.

export function makeBinDir(): string {
	return mkdtempSync(join(tmpdir(), 'bring-fake-bin-'));
}

export function writeFakeBin(
	dir: string,
	name: string,
	script: string,
): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return file;
}

// Mirrors the real `devcontainer --help` of @devcontainers/cli 0.87.0:
// note there is NO stop and NO down — Bring handles those through Docker.
export const HEALTHY_DEVCONTAINER = `case "$1" in
	--version) echo "0.87.0" ;;
	--help)
		echo "devcontainer <command>"
		echo ""
		echo "Commands:"
		echo "  devcontainer up                   Create and run dev container"
		echo "  devcontainer set-up               Set up an existing container as a dev container"
		echo "  devcontainer build [path]         Build a dev container image"
		echo "  devcontainer run-user-commands    Run user commands"
		echo "  devcontainer read-configuration   Read configuration"
		echo "  devcontainer outdated             Show current and available versions"
		echo "  devcontainer upgrade              Upgrade lockfile"
		echo "  devcontainer features             Features commands"
		echo "  devcontainer templates            Templates commands"
		echo "  devcontainer exec <cmd> [args..]  Execute a command on a running dev container"
		;;
esac`;

export const HEALTHY_DOCKER = `case "$1" in
	--version) echo "Docker version 28.1.1, build 4eba377" ;;
	context) echo "default" ;;
	info) echo "28.1.1" ;;
esac`;

export function stoppedDaemonDocker(): string {
	return `case "$1" in
	--version) echo "Docker version 28.1.1, build 4eba377" ;;
	context) echo "default" ;;
	info)
		echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
		exit 1
		;;
esac`;
}

export function permissionDeniedDocker(): string {
	return `case "$1" in
	--version) echo "Docker version 28.1.1, build 4eba377" ;;
	context) echo "default" ;;
	info)
		echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2
		exit 1
		;;
esac`;
}

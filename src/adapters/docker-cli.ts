import type { ContainerInfo, ForwardedPort } from '../core/types.js';
import { type RunOptions, runCommand } from './process-runner.js';

// Docker inventory adapter (P1-16, spec §9.3). The upstream devcontainer CLI
// has no lifecycle stop/down commands (amendment A1), so Bring finds a
// workspace's containers through the label the CLI stamps on them and
// stops/removes them with plain docker. Inventory is read-mostly; mutations
// here are exactly `docker stop` and `docker rm`, nothing broader.

export const WORKSPACE_LABEL = 'devcontainer.local_folder';

export type DockerResult<T> =
	| { ok: true; value: T }
	| { ok: false; message: string };

export async function listWorkspaceContainers(
	executable: string,
	workspaceRoot: string,
	options: RunOptions = {},
): Promise<DockerResult<ContainerInfo[]>> {
	const outcome = await runCommand(
		executable,
		[
			'ps',
			'--all',
			'--filter',
			`label=${WORKSPACE_LABEL}=${workspaceRoot}`,
			'--format',
			'{{json .}}',
		],
		options,
	);
	if (outcome.outcome !== 'ran') {
		return { ok: false, message: outcome.message };
	}
	if (outcome.result.exitCode !== 0) {
		return { ok: false, message: outcome.result.stderr.trim() };
	}
	return { ok: true, value: parsePsLines(outcome.result.stdout) };
}

export async function stopContainers(
	executable: string,
	ids: readonly string[],
	options: RunOptions = {},
): Promise<DockerResult<void>> {
	return mutate(executable, ['stop', ...ids], options);
}

export async function removeContainers(
	executable: string,
	ids: readonly string[],
	options: RunOptions = {},
): Promise<DockerResult<void>> {
	return mutate(executable, ['rm', ...ids], options);
}

async function mutate(
	executable: string,
	argv: string[],
	options: RunOptions,
): Promise<DockerResult<void>> {
	const outcome = await runCommand(executable, argv, options);
	if (outcome.outcome !== 'ran') {
		return { ok: false, message: outcome.message };
	}
	if (outcome.result.exitCode !== 0) {
		return { ok: false, message: outcome.result.stderr.trim() };
	}
	return { ok: true, value: undefined };
}

/** Parse `docker ps --format {{json .}}` output: one JSON object per line. */
export function parsePsLines(stdout: string): ContainerInfo[] {
	const containers: ContainerInfo[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			const row = JSON.parse(trimmed) as Record<string, string>;
			containers.push({
				id: row['ID'] ?? '',
				name: row['Names'] ?? '',
				state: row['State'] ?? 'unknown',
				image: row['Image'] ?? '',
				ports: parsePorts(row['Ports'] ?? ''),
			});
		} catch {
			// A malformed line never sinks the inventory.
		}
	}
	return containers;
}

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 3000/tcp" → unique port pairs. */
export function parsePorts(portsField: string): ForwardedPort[] {
	const ports: ForwardedPort[] = [];
	const seen = new Set<string>();
	for (const part of portsField.split(',')) {
		const match = part.trim().match(/^(?:.*:(\d+)->)?(\d+)\/\w+$/);
		if (match === null) {
			continue;
		}
		const hostPort = match[1] !== undefined ? Number(match[1]) : undefined;
		const containerPort = Number(match[2]);
		const key = `${hostPort ?? '-'}:${containerPort}`;
		if (!seen.has(key)) {
			seen.add(key);
			ports.push(
				hostPort === undefined
					? { containerPort }
					: { containerPort, hostPort },
			);
		}
	}
	return ports;
}

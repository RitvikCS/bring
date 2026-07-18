import type {
	DevContainerImageResource,
	DockerContainerResource,
} from '../core/resources.js';
import { DEVCONTAINER_METADATA_LABEL } from '../core/resources.js';
import type { ContainerInfo, ForwardedPort } from '../core/types.js';
import { type RunOptions, runCommand } from './process-runner.js';

// Docker inventory adapter (P1-16, spec §9.3). The upstream devcontainer CLI
// has no lifecycle stop/down commands (amendment A1), so Bring finds a
// workspace's containers through the label the CLI stamps on them and
// stops/removes them with plain docker. Inventory is read-mostly; mutations
// here are exactly `docker stop` and `docker rm`, nothing broader.

export const WORKSPACE_LABEL = 'devcontainer.local_folder';

interface DockerImageInspect {
	Id?: string;
	Created?: string;
	RepoTags?: string[] | null;
	Size?: number;
	RootFS?: {
		Layers?: string[];
	};
}

interface DockerContainerInspect {
	Id?: string;
	Name?: string;
	Created?: string;
	Image?: string;
	Config?: {
		Image?: string;
		Labels?: Record<string, string> | null;
	};
}

type ImageWithoutImpact = Omit<
	DevContainerImageResource,
	| 'containerNames'
	| 'descendantContainerNames'
	| 'workspacePaths'
	| 'workspaceNames'
	| 'usage'
>;

export interface DevContainerImageListing {
	/** Only metadata-labelled images and exact Dev Container image ids. */
	images: ImageWithoutImpact[];
	/** Includes other container images solely for local ancestry comparison. */
	layerIdsByImageId: Record<string, string[]>;
}

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

/**
 * List every Docker container with exact image ids and labels. Filtering to
 * Dev Container resources happens in the application layer, where Compose
 * sidecars can be related to their positively-labelled primary container.
 */
export async function listAllContainers(
	executable: string,
	options: RunOptions = {},
): Promise<DockerResult<DockerContainerResource[]>> {
	const listed = await runCommand(
		executable,
		['ps', '--all', '--no-trunc', '--format', '{{json .}}'],
		options,
	);
	const listResult = commandOutput(listed);
	if (!listResult.ok) {
		return listResult;
	}
	const rows = parseContainerListLines(listResult.value);
	if (rows.length === 0) {
		return { ok: true, value: [] };
	}
	const inspected = await inspectBatches<DockerContainerInspect>(
		executable,
		'container',
		rows.map((row) => row.id),
		options,
	);
	if (!inspected.ok) {
		return inspected;
	}
	const byId = new Map(inspected.value.map((item) => [item.Id ?? '', item]));
	return {
		ok: true,
		value: rows.map((row) => {
			const detail = byId.get(row.id);
			return {
				id: row.id,
				name: trimContainerName(detail?.Name ?? row.name),
				state: row.state,
				statusText: row.statusText,
				createdAt: detail?.Created ?? row.createdAt,
				imageId: detail?.Image ?? '',
				imageName: detail?.Config?.Image ?? row.imageName,
				ports: row.ports,
				labels: detail?.Config?.Labels ?? {},
			};
		}),
	};
}

/**
 * List images carrying the upstream devcontainer metadata label, plus any
 * extra image ids used by identified Dev Container containers. Inspect gives
 * exact byte sizes; the `docker image ls` human size is not used for math.
 */
export async function listDevContainerImages(
	executable: string,
	additionalImageIds: readonly string[],
	options: RunOptions & { lineageImageIds?: readonly string[] } = {},
): Promise<DockerResult<DevContainerImageListing>> {
	const { lineageImageIds = [], ...runOptions } = options;
	const listed = await runCommand(
		executable,
		[
			'image',
			'ls',
			'--all',
			'--no-trunc',
			'--filter',
			`label=${DEVCONTAINER_METADATA_LABEL}`,
			'--format',
			'{{json .}}',
		],
		runOptions,
	);
	const listResult = commandOutput(listed);
	if (!listResult.ok) {
		return listResult;
	}
	const listRows = parseImageListLines(listResult.value);
	const ids = [
		...new Set([
			...listRows.map((row) => row.id),
			...additionalImageIds.filter((id) => id !== ''),
		]),
	];
	if (ids.length === 0) {
		return { ok: true, value: { images: [], layerIdsByImageId: {} } };
	}
	const inspectIds = [
		...new Set([...ids, ...lineageImageIds.filter((id) => id !== '')]),
	];
	const inspected = await inspectBatches<DockerImageInspect>(
		executable,
		'image',
		inspectIds,
		runOptions,
	);
	if (!inspected.ok) {
		return inspected;
	}
	const byId = new Map(inspected.value.map((image) => [image.Id ?? '', image]));
	return {
		ok: true,
		value: {
			images: ids.flatMap((id) => {
				const image = byId.get(id);
				if (image === undefined) {
					return [];
				}
				const references = (image.RepoTags ?? []).filter(
					(reference) => reference !== '<none>:<none>',
				);
				return [
					{
						id: image.Id ?? '',
						references,
						displayName: references[0] ?? '<none>:<none>',
						createdAt: image.Created ?? '',
						sizeBytes: image.Size ?? 0,
						dangling: references.length === 0,
					},
				];
			}),
			layerIdsByImageId: Object.fromEntries(
				inspected.value
					.filter((image) => image.Id !== undefined)
					.map((image) => [image.Id as string, image.RootFS?.Layers ?? []]),
			),
		},
	};
}

/** Remove images without `--force`; Docker remains the final in-use guard. */
export async function removeImages(
	executable: string,
	ids: readonly string[],
	options: RunOptions = {},
): Promise<DockerResult<void>> {
	return mutate(executable, ['image', 'rm', '--no-prune', ...ids], options);
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
				id: row.ID ?? '',
				name: row.Names ?? '',
				state: row.State ?? 'unknown',
				statusText: row.Status ?? '',
				image: row.Image ?? '',
				ports: parsePorts(row.Ports ?? ''),
			});
		} catch {
			// A malformed line never sinks the inventory.
		}
	}
	return containers;
}

interface ContainerListRow {
	id: string;
	name: string;
	state: string;
	statusText: string;
	createdAt: string;
	imageName: string;
	ports: ForwardedPort[];
}

export function parseContainerListLines(stdout: string): ContainerListRow[] {
	return parseJsonLines(stdout).map((row) => ({
		id: row.ID ?? '',
		name: row.Names ?? '',
		state: row.State ?? 'unknown',
		statusText: row.Status ?? '',
		createdAt: row.CreatedAt ?? '',
		imageName: row.Image ?? '',
		ports: parsePorts(row.Ports ?? ''),
	}));
}

export function parseImageListLines(stdout: string): { id: string }[] {
	return parseJsonLines(stdout)
		.map((row) => ({ id: row.ID ?? '' }))
		.filter((row) => row.id !== '');
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

function parseJsonLines(stdout: string): Record<string, string>[] {
	const rows: Record<string, string>[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			rows.push(JSON.parse(trimmed) as Record<string, string>);
		} catch {
			// Docker occasionally interleaves warnings; malformed lines are skipped.
		}
	}
	return rows;
}

function commandOutput(
	outcome: Awaited<ReturnType<typeof runCommand>>,
): DockerResult<string> {
	if (outcome.outcome !== 'ran') {
		return { ok: false, message: outcome.message };
	}
	if (outcome.result.exitCode !== 0) {
		return { ok: false, message: outcome.result.stderr.trim() };
	}
	return { ok: true, value: outcome.result.stdout };
}

async function inspectBatches<T>(
	executable: string,
	resource: 'container' | 'image',
	ids: readonly string[],
	options: RunOptions,
): Promise<DockerResult<T[]>> {
	const values: T[] = [];
	const batchSize = 64;
	for (let start = 0; start < ids.length; start += batchSize) {
		const batch = ids.slice(start, start + batchSize);
		const outcome = await runCommand(
			executable,
			[resource, 'inspect', ...batch],
			options,
		);
		const output = commandOutput(outcome);
		if (!output.ok) {
			return output;
		}
		try {
			const parsed = JSON.parse(output.value) as unknown;
			if (!Array.isArray(parsed)) {
				return {
					ok: false,
					message: `Docker ${resource} inspect returned invalid JSON.`,
				};
			}
			values.push(...(parsed as T[]));
		} catch {
			return {
				ok: false,
				message: `Docker ${resource} inspect returned invalid JSON.`,
			};
		}
	}
	return { ok: true, value: values };
}

function trimContainerName(name: string): string {
	return name.startsWith('/') ? name.slice(1) : name;
}

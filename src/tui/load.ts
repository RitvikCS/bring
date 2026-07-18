import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { findExecutable } from '../adapters/find-executable.js';
import { bringDown } from '../application/bring-down.js';
import { bringUp } from '../application/bring-up.js';
import {
	type ContainerActionResult,
	mutateContainer,
	openContainerShell,
} from '../application/container-actions.js';
import type { OperationContext } from '../application/context.js';
import { type DoctorReport, runDoctor } from '../application/doctor.js';
import {
	type ImageRemovalResult,
	removeImageResources,
} from '../application/image-actions.js';
import {
	listResources,
	type ResourceInventoryResult,
} from '../application/list-resources.js';
import { openShell } from '../application/open-shell.js';
import { resolveTarget } from '../application/resolve-target.js';
import type { BringProblem } from '../core/errors.js';
import type { EmitEvent, OperationResult } from '../core/operation-events.js';
import {
	type DevContainerImageResource,
	type DevContainerResource,
	type ResourceInventory,
	summarizeWorkspaceContainers,
} from '../core/resources.js';
import type { WorkspaceRef } from '../core/types.js';
import { workspaceIdentity } from '../core/workspace-resolver.js';
import { readLatestLog, readLogTail } from '../stores/log-store.js';
import { bringStateDir } from '../stores/paths.js';
import { loadState, stateFilePath } from '../stores/workspace-store.js';
import { sanitizeLogLine, type TuiWorkspace } from './state.js';

/**
 * Everything the TUI does to the world, behind one seam. App.tsx only calls
 * these; tests hand it a fake and drive whole flows without a process spawn.
 */
export interface TuiEnvironment {
	doctor(): Promise<DoctorReport>;
	/** One coordinated read for every pane; avoids N Docker queries per refresh. */
	load(options?: { includeImages?: boolean }): Promise<TuiData>;
	up(
		workspace: WorkspaceRef,
		options: { rebuild?: boolean },
		emit: EmitEvent,
	): Promise<OperationResult>;
	down(
		workspace: WorkspaceRef,
		options: { remove?: boolean },
		emit: EmitEvent,
	): Promise<OperationResult>;
	/** Runs while the terminal is suspended — inherited stdio (§13.4). */
	shell(workspace: WorkspaceRef): Promise<OperationResult>;
	containerShell(
		container: DevContainerResource,
	): Promise<ContainerActionResult>;
	mutateContainer(
		container: DevContainerResource,
		action: 'stop' | 'remove',
	): Promise<ContainerActionResult>;
	removeImages(
		images: readonly DevContainerImageResource[],
	): Promise<ImageRemovalResult>;
	readLog(workspace: WorkspaceRef): string | null;
}

export interface TuiData {
	workspaces: TuiWorkspace[];
	resources: ResourceInventory;
	resourceProblem: BringProblem | null;
	dotfilesRepository: string | null;
}

export function realEnvironment(
	env: NodeJS.ProcessEnv,
	cwd: string = process.cwd(),
): TuiEnvironment {
	const stateDir = bringStateDir(env);
	const stateFile = stateFilePath(env);

	const contextFor = (emit: EmitEvent): OperationContext | null => {
		const devcontainerExe = findExecutable('devcontainer', env.PATH);
		const dockerExe = findExecutable('docker', env.PATH);
		if (devcontainerExe === null || dockerExe === null) {
			return null;
		}
		return { devcontainerExe, dockerExe, stateDir, stateFile, env, emit };
	};

	const mustContext = (emit: EmitEvent): OperationContext => {
		const ctx = contextFor(emit);
		if (ctx === null) {
			// Doctor gates the ready screen, so this is a mid-session removal.
			throw new Error('The Dev Containers CLI or Docker vanished from PATH.');
		}
		return ctx;
	};

	return {
		doctor: () => runDoctor({ env }),
		load: async (options) => {
			const ctx = contextFor(() => {});
			const storedState = loadState(stateFile);
			const here = resolveTarget('.', { cwd, stateFile }).result;
			const knownWorkspacePaths = storedState.workspaces.map(
				(workspace) => workspace.path,
			);
			if (
				here.outcome === 'resolved' &&
				!knownWorkspacePaths.includes(here.workspace.rootPath)
			) {
				knownWorkspacePaths.push(here.workspace.rootPath);
			}
			const resourceResult: ResourceInventoryResult =
				ctx === null
					? {
							ok: false,
							problem: {
								code: 'DOCKER_FAILED',
								summary: 'Docker is not available for resource inventory.',
								remedy: 'bring doctor',
							},
						}
					: await listResources({
							dockerExe: ctx.dockerExe,
							env,
							includeImages: options?.includeImages,
							knownWorkspacePaths,
						});
			const resources = resourceResult.ok
				? resourceResult.inventory
				: emptyInventory();
			const entries = storedState.workspaces;
			const listed = entries.map((entry) =>
				loadOne(resources, resourceResult.ok, stateDir, entry),
			);
			// First-contact affordance: if the directory the TUI was opened
			// from has a devcontainer config but was never brought up, list
			// it anyway — an empty screen in a valid project is a dead end.
			if (
				here.outcome === 'resolved' &&
				!listed.some((w) => w.ref.rootPath === here.workspace.rootPath)
			) {
				const current = loadOne(resources, resourceResult.ok, stateDir, {
					path: here.workspace.rootPath,
					lastUsedAt: '',
					lastConfigPath: here.workspace.configPath,
				});
				listed.push({ ...current, unregistered: true });
			}
			return {
				workspaces: listed,
				resources,
				resourceProblem: resourceResult.ok ? null : resourceResult.problem,
				dotfilesRepository: storedState.dotfilesRepository ?? null,
			};
		},
		up: (workspace, options, emit) =>
			bringUp(mustContext(emit), workspace, {
				config: workspace.configPath,
				rebuild: options.rebuild,
			}),
		down: (workspace, options, emit) =>
			bringDown(mustContext(emit), workspace, options),
		shell: (workspace) =>
			openShell(
				mustContext(() => {}),
				workspace,
				['bash'],
				workspace.configPath,
			),
		containerShell: (container) =>
			openContainerShell(
				mustContext(() => {}),
				container,
			),
		mutateContainer: (container, action) =>
			mutateContainer(
				mustContext(() => {}),
				container,
				action,
			),
		removeImages: (images) =>
			removeImageResources(
				mustContext(() => {}),
				images,
			),
		readLog: (workspace) => readLatestLog(stateDir, workspace.identity),
	};
}

/**
 * Devcontainer logs end in machinery the detail pane already covers:
 * bare `[timestamp]` lines and the one-line `{"outcome":…}` result JSON.
 * The tail should show what HAPPENED, so those are skipped.
 */
export function interestingLogLine(line: string): boolean {
	if (/^\[[\d\-T:.Z ]+\]\s*$/.test(line)) {
		return false;
	}
	if (line.startsWith('{"outcome"')) {
		return false;
	}
	return line.trim().length > 0;
}

function loadOne(
	resources: ResourceInventory,
	resourceInventoryHealthy: boolean,
	stateDir: string,
	entry: { path: string; lastUsedAt: string; lastConfigPath: string },
): TuiWorkspace {
	const ref: WorkspaceRef = {
		input: entry.path,
		rootPath: entry.path,
		configPath: entry.lastConfigPath,
		identity: workspaceIdentity(entry.path),
	};
	const base: TuiWorkspace = {
		ref,
		name: basename(entry.path),
		status: 'unknown',
		lastUsedAt: entry.lastUsedAt,
		containerIds: [],
		imageNames: [],
		forwardedPorts: [],
		logTail: readLogTail(stateDir, ref.identity, 12)
			.map(sanitizeLogLine)
			.filter(interestingLogLine)
			.slice(-3),
	};
	if (!existsSync(entry.path) || !existsSync(entry.lastConfigPath)) {
		return { ...base, status: 'missing-config' };
	}
	if (!resourceInventoryHealthy) {
		return base;
	}
	return {
		...base,
		...summarizeWorkspaceContainers(
			resources.containers.filter(
				(container) => container.workspacePath === ref.rootPath,
			),
		),
	};
}

function emptyInventory(): ResourceInventory {
	// images: null — a failed pass inspected nothing; the reducer keeps the
	// previous image list (and marks) instead of showing a false empty state.
	return {
		containers: [],
		images: null,
		refreshedAt: new Date(0).toISOString(),
	};
}

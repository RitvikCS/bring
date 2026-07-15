import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { findExecutable } from '../adapters/find-executable.js';
import { bringDown } from '../application/bring-down.js';
import { bringUp } from '../application/bring-up.js';
import type { OperationContext } from '../application/context.js';
import { type DoctorReport, runDoctor } from '../application/doctor.js';
import { getSnapshot } from '../application/get-status.js';
import { openShell } from '../application/open-shell.js';
import { resolveTarget } from '../application/resolve-target.js';
import type { EmitEvent, OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import { workspaceIdentity } from '../core/workspace-resolver.js';
import { readLatestLog } from '../stores/log-store.js';
import { bringStateDir } from '../stores/paths.js';
import { loadState, stateFilePath } from '../stores/workspace-store.js';
import type { TuiWorkspace } from './state.js';

/**
 * Everything the TUI does to the world, behind one seam. App.tsx only calls
 * these; tests hand it a fake and drive whole flows without a process spawn.
 */
export interface TuiEnvironment {
	doctor(): Promise<DoctorReport>;
	loadWorkspaces(): Promise<TuiWorkspace[]>;
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
	readLog(workspace: WorkspaceRef): string | null;
	/** The user-wide dotfiles default, if one is remembered (A6). */
	dotfilesDefault(): string | null;
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
		loadWorkspaces: async () => {
			const ctx = contextFor(() => {});
			const entries = loadState(stateFile).workspaces;
			const listed = await Promise.all(
				entries.map((entry) => loadOne(ctx, entry)),
			);
			// First-contact affordance: if the directory the TUI was opened
			// from has a devcontainer config but was never brought up, list
			// it anyway — an empty screen in a valid project is a dead end.
			const here = resolveTarget('.', { cwd, stateFile }).result;
			if (
				here.outcome === 'resolved' &&
				!listed.some((w) => w.ref.rootPath === here.workspace.rootPath)
			) {
				const current = await loadOne(ctx, {
					path: here.workspace.rootPath,
					lastUsedAt: '',
					lastConfigPath: here.workspace.configPath,
				});
				listed.push({ ...current, unregistered: true });
			}
			return listed;
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
		readLog: (workspace) => readLatestLog(stateDir, workspace.identity),
		dotfilesDefault: () => loadState(stateFile).dotfilesRepository ?? null,
	};
}

async function loadOne(
	ctx: OperationContext | null,
	entry: { path: string; lastUsedAt: string; lastConfigPath: string },
): Promise<TuiWorkspace> {
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
	};
	if (!existsSync(entry.path) || !existsSync(entry.lastConfigPath)) {
		return { ...base, status: 'missing-config' };
	}
	if (ctx === null) {
		return base;
	}
	const result = await getSnapshot(ctx, ref);
	if (!result.ok) {
		return base;
	}
	return {
		...base,
		status: result.snapshot.status,
		containerIds: result.snapshot.containerIds,
		imageNames: result.snapshot.imageNames,
		forwardedPorts: result.snapshot.forwardedPorts,
	};
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bringStateDir } from './paths.js';

export interface StoredWorkspace {
	path: string;
	lastUsedAt: string;
	lastConfigPath: string;
}

export interface BringState {
	schemaVersion: 1;
	workspaces: StoredWorkspace[];
}

const EMPTY_STATE: BringState = { schemaVersion: 1, workspaces: [] };

export function stateFilePath(env: NodeJS.ProcessEnv): string {
	return join(bringStateDir(env), 'state.json');
}

/**
 * Load the workspace registry (spec §7.4). A missing, unreadable, or corrupt
 * state file is never an error — Bring recovers with an empty registry, since
 * devcontainer.json files remain the authoritative source of truth.
 */
export function loadState(stateFile: string): BringState {
	let raw: string;
	try {
		raw = readFileSync(stateFile, 'utf8');
	} catch {
		return structuredClone(EMPTY_STATE);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			(parsed as BringState).schemaVersion === 1 &&
			Array.isArray((parsed as BringState).workspaces)
		) {
			return parsed as BringState;
		}
	} catch {
		// fall through to recovery
	}
	return structuredClone(EMPTY_STATE);
}

/**
 * Remember a successfully resolved workspace. Upserts by real path and writes
 * atomically (temp file + rename) so a crash can never half-write state.
 * Directories are user-only: state may reveal project paths.
 */
export function rememberWorkspace(
	stateFile: string,
	workspace: { rootPath: string; configPath: string },
	now: Date = new Date(),
): BringState {
	const state = loadState(stateFile);
	const entry: StoredWorkspace = {
		path: workspace.rootPath,
		lastUsedAt: now.toISOString(),
		lastConfigPath: workspace.configPath,
	};
	const existing = state.workspaces.findIndex(
		(w) => w.path === workspace.rootPath,
	);
	if (existing === -1) {
		state.workspaces.push(entry);
	} else {
		state.workspaces[existing] = entry;
	}
	writeStateAtomically(stateFile, state);
	return state;
}

function writeStateAtomically(stateFile: string, state: BringState): void {
	mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
	const temp = `${stateFile}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, stateFile);
}

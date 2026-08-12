import { basename, isAbsolute, resolve } from 'node:path';
import { workspaceIdentity } from '../core/workspace-resolver.js';
import { clearLogs } from '../stores/log-store.js';
import {
	forgetWorkspace,
	loadState,
	type StoredWorkspace,
} from '../stores/workspace-store.js';

// `bring forget <workspace>`: drop a remembered workspace from the registry.
// The registry is the only thing touched — containers, images, and source
// files stay. This is how a stale or deleted project leaves `bring ls` and
// the TUI without hand-editing state.json.

export type ForgetResult =
	| { outcome: 'forgotten'; entry: StoredWorkspace; name: string }
	| { outcome: 'empty-registry' }
	| { outcome: 'not-found'; target: string }
	| { outcome: 'ambiguous'; target: string; candidates: string[] };

export interface ForgetContext {
	stateFile: string;
	stateDir: string;
	cwd: string;
}

/**
 * Resolve the target against the registry, not the filesystem: the whole
 * point of forget is cleaning up entries whose directories may be gone.
 * A path-looking target matches by absolute path; a bare word matches the
 * workspace name (directory basename) and must be unambiguous.
 */
export function runForget(ctx: ForgetContext, target: string): ForgetResult {
	const state = loadState(ctx.stateFile);
	if (state.workspaces.length === 0) {
		return { outcome: 'empty-registry' };
	}

	const looksLikePath =
		isAbsolute(target) ||
		target.includes('/') ||
		target === '.' ||
		target === '..' ||
		target === 'this';
	const asPath = resolve(ctx.cwd, target === 'this' ? '.' : target);

	let match = state.workspaces.find((w) => w.path === asPath) ?? null;
	if (match === null && !looksLikePath) {
		const byName = state.workspaces.filter((w) => basename(w.path) === target);
		if (byName.length > 1) {
			return {
				outcome: 'ambiguous',
				target,
				candidates: byName.map((w) => w.path),
			};
		}
		match = byName[0] ?? null;
	}
	if (match === null) {
		return { outcome: 'not-found', target };
	}

	forgetWorkspace(ctx.stateFile, match.path);
	// Forget the operation logs too — they are keyed by the same identity and
	// would otherwise linger for a workspace Bring no longer knows.
	clearLogs(ctx.stateDir, workspaceIdentity(match.path));
	return { outcome: 'forgotten', entry: match, name: basename(match.path) };
}

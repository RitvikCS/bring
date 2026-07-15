import {
	type ResolveResult,
	resolveWorkspace,
} from '../core/workspace-resolver.js';
import { loadState } from '../stores/workspace-store.js';

export interface ResolvedTarget {
	result: ResolveResult;
	/** Set when an ambiguity was settled by the remembered last --config. */
	usedRememberedConfig?: string;
}

/**
 * Resolution with memory (amendment A5): a directory with two configs is
 * ambiguous exactly once. After the user settles it with `--config` and the
 * operation succeeds, the registry's `lastConfigPath` settles every later
 * command for that workspace — an explicit `--config` always overrides, and
 * a remembered config that no longer matches the candidates is ignored (so
 * this never *introduces* a guess, it only replays the user's own choice).
 */
export function resolveTarget(
	input: string,
	options: { cwd: string; explicitConfig?: string; stateFile: string },
): ResolvedTarget {
	const first = resolveWorkspace(input, {
		cwd: options.cwd,
		explicitConfig: options.explicitConfig,
	});
	if (first.outcome !== 'ambiguous' || options.explicitConfig !== undefined) {
		return { result: first };
	}

	const remembered = loadState(options.stateFile).workspaces.find(
		(w) => w.path === first.root,
	)?.lastConfigPath;
	if (remembered === undefined || !first.configs.includes(remembered)) {
		return { result: first };
	}

	const settled = resolveWorkspace(input, {
		cwd: options.cwd,
		explicitConfig: remembered,
	});
	return settled.outcome === 'resolved'
		? { result: settled, usedRememberedConfig: remembered }
		: { result: first };
}

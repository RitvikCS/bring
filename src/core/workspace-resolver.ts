import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { BringProblem } from './errors.js';
import type { WorkspaceRef } from './types.js';

// The two configuration locations Phase 1 recognizes (spec §7.2), in the
// order they take precedence within one directory.
const CONFIG_LOCATIONS = [
	join('.devcontainer', 'devcontainer.json'),
	'.devcontainer.json',
] as const;

export type ResolveResult =
	| { outcome: 'resolved'; workspace: WorkspaceRef }
	| { outcome: 'not-found'; problem: BringProblem }
	| { outcome: 'no-config'; searchedRoot: string; problem: BringProblem }
	| {
			outcome: 'ambiguous';
			root: string;
			configs: string[];
			problem: BringProblem;
	  };

export interface ResolveOptions {
	cwd: string;
	/** From --config: a path relative to the target directory (or absolute). */
	explicitConfig?: string;
}

/**
 * Turn a user target (".", "this", a path) into a workspace (spec §7.1).
 *
 * Resolution never guesses: two configs in the same directory is a typed
 * ambiguity, and nothing is executed after any failure here. Discovery walks
 * upward to the nearest ancestor with a config and stops at the filesystem
 * root — it never scans downward or across the home directory.
 */
export function resolveWorkspace(
	input: string,
	options: ResolveOptions,
): ResolveResult {
	const raw =
		input === '.' || input === 'this' || input === ''
			? options.cwd
			: isAbsolute(input)
				? input
				: resolve(options.cwd, input);

	let target: string;
	try {
		target = realpathSync(raw);
	} catch {
		return {
			outcome: 'not-found',
			problem: {
				code: 'WORKSPACE_NOT_FOUND',
				summary: `${raw} does not exist.`,
			},
		};
	}
	if (!statSync(target).isDirectory()) {
		return {
			outcome: 'not-found',
			problem: {
				code: 'WORKSPACE_NOT_FOUND',
				summary: `${target} is not a directory.`,
			},
		};
	}

	if (options.explicitConfig !== undefined) {
		const configPath = isAbsolute(options.explicitConfig)
			? options.explicitConfig
			: resolve(target, options.explicitConfig);
		if (!existsSync(configPath)) {
			return {
				outcome: 'no-config',
				searchedRoot: target,
				problem: {
					code: 'CONFIG_NOT_FOUND',
					summary: `The configuration ${configPath} does not exist.`,
				},
			};
		}
		return {
			outcome: 'resolved',
			workspace: makeRef(input, target, configPath),
		};
	}

	for (let dir = target; ; dir = dirname(dir)) {
		const found = CONFIG_LOCATIONS.map((location) =>
			join(dir, location),
		).filter((candidate) => existsSync(candidate));
		if (found.length > 1) {
			return {
				outcome: 'ambiguous',
				root: dir,
				configs: found,
				problem: {
					code: 'CONFIG_AMBIGUOUS',
					summary: `${dir} has more than one Dev Container configuration.`,
					remedy: 'Pick one explicitly with --config <path>.',
				},
			};
		}
		const config = found[0];
		if (config !== undefined) {
			return { outcome: 'resolved', workspace: makeRef(input, dir, config) };
		}
		if (dir === dirname(dir)) {
			break; // filesystem root
		}
	}

	return {
		outcome: 'no-config',
		searchedRoot: target,
		problem: {
			code: 'CONFIG_NOT_FOUND',
			summary: `No Dev Container configuration found for ${target}.`,
		},
	};
}

export function workspaceIdentity(rootPath: string): string {
	return createHash('sha256').update(rootPath).digest('hex').slice(0, 16);
}

function makeRef(
	input: string,
	rootPath: string,
	configPath: string,
): WorkspaceRef {
	return {
		input,
		rootPath,
		configPath,
		identity: workspaceIdentity(rootPath),
	};
}

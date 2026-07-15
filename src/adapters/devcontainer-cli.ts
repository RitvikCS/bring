import {
	type RunOptions,
	type RunOutcome,
	runCommand,
} from './process-runner.js';

// Dev Containers adapter (P1-15, spec §9.2). Every method builds an argv
// array — user paths are never interpolated into a shell string. Exit status
// is the primary success signal; the CLI's JSON result line enriches it.

export interface UpFlags {
	removeExistingContainer?: boolean;
	buildNoCache?: boolean;
	config?: string;
}

export interface UpSuccess {
	outcome: 'success';
	containerId?: string;
	remoteWorkspaceFolder?: string;
}

export function upArgv(workspaceRoot: string, flags: UpFlags = {}): string[] {
	const argv = ['up', '--workspace-folder', workspaceRoot];
	if (flags.config !== undefined) {
		argv.push('--config', flags.config);
	}
	if (flags.removeExistingContainer === true) {
		argv.push('--remove-existing-container');
	}
	if (flags.buildNoCache === true) {
		argv.push('--build-no-cache');
	}
	return argv;
}

export function execArgv(
	workspaceRoot: string,
	command: readonly string[],
	config?: string,
): string[] {
	const argv = ['exec', '--workspace-folder', workspaceRoot];
	if (config !== undefined) {
		argv.push('--config', config);
	}
	return [...argv, ...command];
}

export function readConfigurationArgv(
	workspaceRoot: string,
	config?: string,
): string[] {
	const argv = ['read-configuration', '--workspace-folder', workspaceRoot];
	if (config !== undefined) {
		argv.push('--config', config);
	}
	return argv;
}

export function runUp(
	executable: string,
	workspaceRoot: string,
	flags: UpFlags,
	options: RunOptions = {},
): Promise<RunOutcome> {
	return runCommand(executable, upArgv(workspaceRoot, flags), options);
}

export function runExec(
	executable: string,
	workspaceRoot: string,
	command: readonly string[],
	options: RunOptions = {},
	config?: string,
): Promise<RunOutcome> {
	return runCommand(
		executable,
		execArgv(workspaceRoot, command, config),
		options,
	);
}

/**
 * Extract the CLI's single-line JSON result from `devcontainer up` stdout.
 * The line may be surrounded by build noise; the last parseable JSON object
 * with an `outcome` field wins. Absence is not an error (spec: never depend
 * on log text alone) — callers fall back to the exit code.
 */
export function parseUpResult(stdout: string): UpSuccess | null {
	const lines = stdout.trim().split('\n').reverse();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				'outcome' in parsed &&
				(parsed as { outcome: unknown }).outcome === 'success'
			) {
				return parsed as UpSuccess;
			}
		} catch {
			// keep scanning
		}
	}
	return null;
}

// Rebuild needs flags the capability detector must confirm first (spec §9.2).
export const REBUILD_FLAGS = {
	replace: '--remove-existing-container',
	noCache: '--build-no-cache',
} as const;

/**
 * Check `devcontainer up --help` for the rebuild flags. Bring refuses to
 * guess: a missing flag makes rebuild an UNSUPPORTED_CAPABILITY (exit 4)
 * instead of a mystery upstream error.
 */
export async function detectUpFlags(
	executable: string,
	options: RunOptions = {},
): Promise<{ replace: boolean; noCache: boolean } | null> {
	const probe = await runCommand(executable, ['up', '--help'], options);
	if (probe.outcome !== 'ran') {
		return null;
	}
	const text = probe.result.combined;
	return {
		replace: text.includes(REBUILD_FLAGS.replace),
		noCache: text.includes(REBUILD_FLAGS.noCache),
	};
}

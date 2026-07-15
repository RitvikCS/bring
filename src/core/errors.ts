// Stable error codes (spec §14.1). Scripts consuming --json match on these,
// so codes are contractual: never rename or reuse them.

export type BringErrorCode =
	| 'USAGE_ERROR'
	| 'DEPENDENCY_MISSING'
	| 'DEPENDENCY_UNREACHABLE'
	| 'UNSUPPORTED_CAPABILITY'
	| 'WORKSPACE_NOT_FOUND'
	| 'CONFIG_NOT_FOUND'
	| 'CONFIG_AMBIGUOUS'
	| 'OPERATION_CONFLICT'
	| 'DEVCONTAINER_FAILED'
	| 'DOCKER_FAILED'
	| 'USER_CANCELLED'
	| 'INTERRUPTED'
	| 'INTERNAL_ERROR';

export interface BringProblem {
	code: BringErrorCode;
	summary: string;
	/** Ready-to-run command or short instruction that fixes the problem. */
	remedy?: string;
}

/** Map a stable error code to the contractual process exit code (§14.2). */
export function exitCodeForProblem(code: BringErrorCode): number {
	switch (code) {
		case 'USAGE_ERROR':
			return 2;
		case 'WORKSPACE_NOT_FOUND':
		case 'CONFIG_NOT_FOUND':
		case 'CONFIG_AMBIGUOUS':
			return 3;
		case 'DEPENDENCY_MISSING':
		case 'DEPENDENCY_UNREACHABLE':
		case 'UNSUPPORTED_CAPABILITY':
			return 4;
		case 'USER_CANCELLED':
			return 0;
		case 'INTERRUPTED':
			return 130;
		case 'INTERNAL_ERROR':
			return 5;
		case 'OPERATION_CONFLICT':
		case 'DEVCONTAINER_FAILED':
		case 'DOCKER_FAILED':
			return 1;
	}
}

/**
 * Turn a failed `devcontainer up` into a concise, actionable problem
 * (P1-17). Output text only sharpens the summary — the exit code already
 * established the failure, so an unrecognized log is still a valid failure.
 */
export function classifyDevcontainerFailure(
	combined: string,
	exitCode: number,
): BringProblem {
	const patterns: Array<{ test: RegExp; summary: string; remedy?: string }> = [
		{
			test: /Cannot connect to the Docker daemon/i,
			summary: 'Docker stopped responding during the operation.',
			remedy: 'bring doctor',
		},
		{
			test: /permission denied.*docker daemon socket/i,
			summary: 'Docker refused access to the daemon socket.',
			remedy: 'bring doctor',
		},
		{
			test: /post(Create|Start|Attach)Command.*(failed|exited)|failed.*post(Create|Start|Attach)Command/i,
			summary: 'A lifecycle command in devcontainer.json failed.',
		},
		{
			test: /pull access denied|manifest unknown|not found: manifest/i,
			summary: 'The container image could not be pulled.',
		},
		{
			test: /error parsing|invalid json|unexpected token/i,
			summary: 'devcontainer.json could not be parsed.',
		},
	];
	for (const { test, summary, remedy } of patterns) {
		if (test.test(combined)) {
			return { code: 'DEVCONTAINER_FAILED', summary, remedy };
		}
	}
	return {
		code: 'DEVCONTAINER_FAILED',
		summary: `devcontainer up exited with code ${exitCode}.`,
	};
}

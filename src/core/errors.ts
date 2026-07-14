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

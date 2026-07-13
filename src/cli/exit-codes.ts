// Exit codes are part of Bring's public contract (spec §14.2). Scripts rely
// on them, so they must never be renumbered.
export const EXIT = {
	/** Success, or a cancelled confirmation with no mutation. */
	success: 0,
	/** A Dev Container or Docker operation failed. */
	operationFailed: 1,
	/** Invalid command usage or unknown option. */
	usage: 2,
	/** Workspace or configuration resolution failed. */
	resolution: 3,
	/** Required dependency is missing, unreachable, or unsupported. */
	dependency: 4,
	/** Internal Bring error. */
	internal: 5,
	/** Interrupted with Ctrl+C. */
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

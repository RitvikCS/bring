import type { EmitEvent } from '../core/operation-events.js';

/**
 * Everything an application operation needs, resolved once by the CLI (and
 * later the TUI). Operations never look up executables or state paths
 * themselves, which keeps them trivially testable with fakes.
 */
export interface OperationContext {
	devcontainerExe: string;
	dockerExe: string;
	/** Bring's state directory (logs, locks, registry live under it). */
	stateDir: string;
	/** The workspace registry file (state.json). */
	stateFile: string;
	env: NodeJS.ProcessEnv;
	emit: EmitEvent;
}

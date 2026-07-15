import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Bring keeps its state (spec §7: XDG state dir with the standard
 * fallback). Phase 1A only displays this path in doctor; the state store
 * itself lands in P1-11.
 */
export function bringStateDir(env: NodeJS.ProcessEnv): string {
	const xdgState = env.XDG_STATE_HOME;
	if (xdgState !== undefined && xdgState.length > 0) {
		return join(xdgState, 'bring');
	}
	const home = env.HOME ?? homedir();
	return join(home, '.local', 'state', 'bring');
}

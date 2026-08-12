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

/**
 * Where Bring keeps user configuration (spec §15.1: XDG config dir with the
 * standard fallback). Configuration is declarative user intent (profiles);
 * state.json remains Bring's own memory — the two never share a file.
 */
export function bringConfigDir(env: NodeJS.ProcessEnv): string {
	const xdgConfig = env.XDG_CONFIG_HOME;
	if (xdgConfig !== undefined && xdgConfig.length > 0) {
		return join(xdgConfig, 'bring');
	}
	const home = env.HOME ?? homedir();
	return join(home, '.config', 'bring');
}

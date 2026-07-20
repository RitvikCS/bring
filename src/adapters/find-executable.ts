import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a bare executable name against a PATH string (P1-01).
 *
 * Pure lookup, no shell involved: each PATH entry is checked for a regular
 * file with execute permission. Returns the first match or null. Bring never
 * guesses install locations beyond PATH — if it isn't on PATH, doctor says so.
 */
export function findExecutable(
	name: string,
	pathValue: string | undefined,
): string | null {
	if (name.length === 0 || name.includes('/') || pathValue === undefined) {
		return null;
	}

	for (const entry of pathValue.split(delimiter)) {
		// Empty PATH segments historically mean "current directory"; running
		// dependencies from the cwd is exactly the surprise we want to avoid.
		if (entry.length === 0 || !isAbsolute(entry)) {
			continue;
		}
		const candidate = join(entry, name);
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}

	return null;
}

function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) {
			return false;
		}
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the Dev Containers CLI: a system-wide `devcontainer` on PATH
 * always wins (the user chose that version); otherwise fall back to the
 * copy Bring ships as a dependency, so `npm install -g @ritvikcs/bring`
 * plus Docker is a complete setup. Returns null only when neither exists
 * (a broken install). BRING_NO_BUNDLED_DEVCONTAINER=1 disables the
 * fallback — used by tests that need a "CLI missing" world.
 */
export function findDevcontainerExecutable(
	env: NodeJS.ProcessEnv,
): { path: string; source: 'path' | 'bundled' } | null {
	const onPath = findExecutable('devcontainer', env.PATH);
	if (onPath !== null) {
		return { path: onPath, source: 'path' };
	}
	if (env.BRING_NO_BUNDLED_DEVCONTAINER !== undefined) {
		return null;
	}
	// This file compiles to dist/adapters/, so ../../ is the package root
	// both in the repo (src/adapters/) and in an installed copy.
	const bundled = fileURLToPath(
		new URL('../../node_modules/.bin/devcontainer', import.meta.url),
	);
	return isExecutableFile(bundled)
		? { path: bundled, source: 'bundled' }
		: null;
}

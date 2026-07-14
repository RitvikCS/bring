import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one-time first-run welcome (npm shows nothing at install time, so
 * the first command is the first impression). Returns the unstyled lines
 * exactly once per machine — a marker file in the state dir remembers —
 * and null ever after. Never throws: a read-only disk just means the
 * welcome shows again, which is harmless.
 */
export function firstRunWelcome(
	stateDir: string,
	version: string,
): string[] | null {
	const marker = join(stateDir, 'welcomed');
	if (existsSync(marker)) {
		return null;
	}
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(marker, `${new Date().toISOString()}\n`);
	} catch {
		// Still show the welcome; failing to remember is not failing.
	}
	return [
		`Welcome to Bring ${version} — Dev Containers without the ceremony.`,
		'  bring doctor    check Docker and the (bundled) Dev Containers CLI',
		'  bring this up   start the current project · bare `bring` opens the UI',
		'Guide: https://github.com/RitvikCS/bring#readme',
	];
}

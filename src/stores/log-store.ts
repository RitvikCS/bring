import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Operation logs (P1-14, spec §9.4): private to the user, latest two per
// workspace, never transmitted anywhere. Logs may contain user data from
// child output — Bring makes no redaction claims.

export function logDirFor(stateDir: string, identity: string): string {
	return join(stateDir, 'logs', identity);
}

export function latestLogPath(stateDir: string, identity: string): string {
	return join(logDirFor(stateDir, identity), 'latest.log');
}

/**
 * Persist the raw output of the most recent operation. The previous latest
 * is rotated to previous.log; anything older is gone (retention: two).
 */
export function writeOperationLog(
	stateDir: string,
	identity: string,
	content: string,
): string {
	const dir = logDirFor(stateDir, identity);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const latest = join(dir, 'latest.log');
	if (existsSync(latest)) {
		renameSync(latest, join(dir, 'previous.log'));
	}
	writeFileSync(latest, content, { mode: 0o600 });
	return latest;
}

export function readLatestLog(
	stateDir: string,
	identity: string,
): string | null {
	try {
		return readFileSync(latestLogPath(stateDir, identity), 'utf8');
	} catch {
		return null;
	}
}

export function clearLogs(stateDir: string, identity: string): void {
	rmSync(logDirFor(stateDir, identity), { recursive: true, force: true });
}

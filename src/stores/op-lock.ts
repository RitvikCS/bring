import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-workspace operation lock (P1-25): one mutation at a time per
// workspace, across processes. A lock names the pid that holds it; a lock
// whose pid is dead is stale and silently reclaimed, so a crashed run never
// bricks a workspace.

export type LockResult =
	| { ok: true; release: () => void }
	| { ok: false; holderPid: number };

export function acquireOperationLock(
	stateDir: string,
	identity: string,
): LockResult {
	const dir = join(stateDir, 'locks');
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lockFile = join(dir, `${identity}.lock`);

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lockFile, String(process.pid), {
				flag: 'wx',
				mode: 0o600,
			});
			return {
				ok: true,
				release: () => rmSync(lockFile, { force: true }),
			};
		} catch {
			const holderPid = readHolder(lockFile);
			if (holderPid !== null && isAlive(holderPid)) {
				return { ok: false, holderPid };
			}
			// Stale (holder dead or unreadable): reclaim and retry once.
			rmSync(lockFile, { force: true });
		}
	}
	return { ok: false, holderPid: -1 };
}

function readHolder(lockFile: string): number | null {
	try {
		const pid = Number(readFileSync(lockFile, 'utf8').trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

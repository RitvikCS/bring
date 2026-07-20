import { type ChildProcess, spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The update notifier (spec-adjacent QoL): a cached, non-blocking check
 * against the npm registry so users hear about new versions without Bring
 * ever waiting on the network. The running process only READS the cache;
 * refreshing it happens in a detached child (update-fetch.js) that outlives
 * the command, so `bring ls` never lingers for a fetch.
 *
 * Opt out with BRING_NO_UPDATE_CHECK=1. The notice goes to stderr and only
 * when it is a TTY, so scripts and pipes never see it.
 */

export interface UpdateCache {
	/** ISO timestamp of the last refresh attempt (success or not). */
	checkedAt: string;
	/** Latest published version, or null if the last fetch failed. */
	latest: string | null;
}

const CACHE_FILE = 'update-check.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/** Strictly-newer semver compare on numeric x.y.z parts. */
export function isNewer(latest: string, current: string): boolean {
	const parse = (v: string) =>
		v
			.split('.')
			.map((part) => Number.parseInt(part, 10))
			.slice(0, 3);
	const a = parse(latest);
	const b = parse(current);
	if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN)) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		const left = a[i] as number;
		const right = b[i] as number;
		if (left !== right) {
			return left > right;
		}
	}
	return false;
}

export function readUpdateCache(stateDir: string): UpdateCache | null {
	try {
		const raw = readFileSync(join(stateDir, CACHE_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Partial<UpdateCache>;
		if (typeof parsed.checkedAt !== 'string') {
			return null;
		}
		return {
			checkedAt: parsed.checkedAt,
			latest: typeof parsed.latest === 'string' ? parsed.latest : null,
		};
	} catch {
		// Missing or corrupt cache is never an error — same rule as state.json.
		return null;
	}
}

export function writeUpdateCache(stateDir: string, cache: UpdateCache): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		const target = join(stateDir, CACHE_FILE);
		const temp = `${target}.tmp`;
		writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`);
		renameSync(temp, target);
	} catch {
		// Never let the notifier break a real command.
	}
}

/**
 * The one-line notice (unstyled — the caller paints it), or null when
 * there is nothing newer to talk about.
 */
export function updateNotice(
	stateDir: string,
	currentVersion: string,
): string | null {
	const cache = readUpdateCache(stateDir);
	if (cache?.latest == null || !isNewer(cache.latest, currentVersion)) {
		return null;
	}
	return `Update available ${currentVersion} → ${cache.latest} · npm install -g @ritvikcs/bring`;
}

function cacheIsFresh(cache: UpdateCache | null, now: Date): boolean {
	if (cache === null) {
		return false;
	}
	const checked = Date.parse(cache.checkedAt);
	return !Number.isNaN(checked) && now.getTime() - checked < TTL_MS;
}

/**
 * Kick off a cache refresh in a detached child if the cache is stale.
 * Fire-and-forget: nothing is awaited, errors are ignored, and the child
 * is unref'd so the current command exits on its own schedule.
 */
export function refreshUpdateCacheInBackground(
	stateDir: string,
	env: NodeJS.ProcessEnv,
	options: {
		now?: Date;
		spawnImpl?: (
			command: string,
			args: readonly string[],
			opts: object,
		) => Pick<ChildProcess, 'unref'>;
	} = {},
): boolean {
	if (env.BRING_NO_UPDATE_CHECK !== undefined) {
		return false;
	}
	const now = options.now ?? new Date();
	if (cacheIsFresh(readUpdateCache(stateDir), now)) {
		return false;
	}
	const script = fileURLToPath(new URL('./update-fetch.js', import.meta.url));
	if (!existsSync(script)) {
		// Uncompiled dev runs have no fetch script next to this module.
		return false;
	}
	try {
		const spawnImpl = options.spawnImpl ?? spawn;
		spawnImpl(process.execPath, [script, stateDir], {
			detached: true,
			stdio: 'ignore',
		}).unref();
		return true;
	} catch {
		return false;
	}
}

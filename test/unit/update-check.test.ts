import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	isNewer,
	readUpdateCache,
	refreshUpdateCacheInBackground,
	updateNotice,
	writeUpdateCache,
} from '../../src/cli/update-check.js';

const dirs: string[] = [];
function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bring-update-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('isNewer', () => {
	it('compares numeric semver parts, not strings', () => {
		expect(isNewer('0.2.10', '0.2.9')).toBe(true);
		expect(isNewer('0.10.0', '0.9.9')).toBe(true);
		expect(isNewer('1.0.0', '0.99.99')).toBe(true);
	});

	it('is strictly newer: equal and older are false', () => {
		expect(isNewer('0.2.3', '0.2.3')).toBe(false);
		expect(isNewer('0.2.2', '0.2.3')).toBe(false);
	});

	it('refuses to compare garbage', () => {
		expect(isNewer('latest', '0.2.3')).toBe(false);
		expect(isNewer('', '0.2.3')).toBe(false);
	});
});

describe('update cache', () => {
	it('round-trips through the state dir', () => {
		const dir = tempStateDir();
		writeUpdateCache(dir, {
			checkedAt: '2026-07-19T00:00:00Z',
			latest: '9.9.9',
		});
		expect(readUpdateCache(dir)).toEqual({
			checkedAt: '2026-07-19T00:00:00Z',
			latest: '9.9.9',
		});
	});

	it('treats a missing or corrupt cache as absent, never an error', () => {
		const dir = tempStateDir();
		expect(readUpdateCache(dir)).toBeNull();
		writeFileSync(join(dir, 'update-check.json'), '{nope');
		expect(readUpdateCache(dir)).toBeNull();
	});
});

describe('updateNotice', () => {
	it('mentions both versions and the install command when newer exists', () => {
		const dir = tempStateDir();
		writeUpdateCache(dir, {
			checkedAt: '2026-07-19T00:00:00Z',
			latest: '0.3.0',
		});
		const notice = updateNotice(dir, '0.2.3');
		expect(notice).toContain('0.2.3 → 0.3.0');
		expect(notice).toContain('npm install -g @ritvikcs/bring');
	});

	it('is silent with no cache, a failed fetch, or nothing newer', () => {
		const dir = tempStateDir();
		expect(updateNotice(dir, '0.2.3')).toBeNull();
		writeUpdateCache(dir, { checkedAt: '2026-07-19T00:00:00Z', latest: null });
		expect(updateNotice(dir, '0.2.3')).toBeNull();
		writeUpdateCache(dir, {
			checkedAt: '2026-07-19T00:00:00Z',
			latest: '0.2.3',
		});
		expect(updateNotice(dir, '0.2.3')).toBeNull();
	});
});

describe('refreshUpdateCacheInBackground', () => {
	const fakeSpawn = () => {
		const calls: unknown[][] = [];
		const impl = (...args: unknown[]) => {
			calls.push(args);
			return { unref: () => {} };
		};
		return { calls, impl };
	};

	it('spawns a detached refresh when the cache is stale', () => {
		const dir = tempStateDir();
		writeUpdateCache(dir, { checkedAt: '2026-07-18T00:00:00Z', latest: null });
		const { calls, impl } = fakeSpawn();
		const spawned = refreshUpdateCacheInBackground(
			dir,
			{},
			{
				now: new Date('2026-07-19T12:00:00Z'),
				spawnImpl: impl,
			},
		);
		// In compiled installs the fetch script exists and a spawn happens;
		// in source runs the guard skips it. Either way: no throw, and a
		// spawn implies detached fire-and-forget args.
		if (spawned) {
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[2]).toMatchObject({ detached: true, stdio: 'ignore' });
		} else {
			expect(calls).toHaveLength(0);
		}
	});

	it('never spawns when the cache is fresh or the user opted out', () => {
		const dir = tempStateDir();
		const now = new Date('2026-07-19T12:00:00Z');
		writeUpdateCache(dir, {
			checkedAt: '2026-07-19T11:00:00Z',
			latest: '9.9.9',
		});
		const { calls, impl } = fakeSpawn();
		expect(
			refreshUpdateCacheInBackground(dir, {}, { now, spawnImpl: impl }),
		).toBe(false);
		expect(
			refreshUpdateCacheInBackground(
				dir,
				{ BRING_NO_UPDATE_CHECK: '1' },
				{ now: new Date('2026-08-01T00:00:00Z'), spawnImpl: impl },
			),
		).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it('writes the cache atomically (no .tmp left behind)', () => {
		const dir = tempStateDir();
		writeUpdateCache(dir, {
			checkedAt: '2026-07-19T00:00:00Z',
			latest: '1.0.0',
		});
		expect(() => readFileSync(join(dir, 'update-check.json.tmp'))).toThrow();
	});
});

import { readUpdateCache, writeUpdateCache } from './update-check.js';

/**
 * Standalone entry, run detached by refreshUpdateCacheInBackground:
 * `node update-fetch.js <stateDir>`. Asks the npm registry for the latest
 * published version and records it in the update cache. Always silent;
 * a failed fetch still stamps checkedAt so a broken network is retried
 * once a day, not once a command.
 */
async function main(): Promise<void> {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.length === 0) {
		return;
	}
	const previous = readUpdateCache(stateDir);
	let latest: string | null = previous?.latest ?? null;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const response = await fetch(
			'https://registry.npmjs.org/-/package/@ritvikcs/bring/dist-tags',
			{ signal: controller.signal },
		);
		clearTimeout(timer);
		if (response.ok) {
			const tags = (await response.json()) as { latest?: unknown };
			if (typeof tags.latest === 'string') {
				latest = tags.latest;
			}
		}
	} catch {
		// Offline or blocked: keep whatever we knew before.
	}
	writeUpdateCache(stateDir, {
		checkedAt: new Date().toISOString(),
		latest,
	});
}

await main();

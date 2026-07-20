import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firstRunWelcome } from '../../src/cli/welcome.js';

const dirs: string[] = [];
function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bring-welcome-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('firstRunWelcome', () => {
	it('welcomes exactly once per machine, and never again', () => {
		const dir = tempStateDir();
		const first = firstRunWelcome(dir, '0.2.3');
		expect(first?.join('\n')).toContain('Welcome to Bring 0.2.3');
		expect(first?.join('\n')).toContain('bring doctor');
		expect(existsSync(join(dir, 'welcomed'))).toBe(true);
		// A later run — including after any package update — stays silent:
		// the marker lives in the state dir, which npm upgrades never touch.
		expect(firstRunWelcome(dir, '0.9.9')).toBeNull();
	});
});

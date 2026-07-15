import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/adapters/process-runner.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

describe('runCommand', () => {
	it('captures stdout, stderr, and combined output in order', async () => {
		const bin = writeFakeBin(
			makeBinDir(),
			'talker',
			'echo one\necho two >&2\necho three',
		);
		const outcome = await runCommand(bin, []);
		expect(outcome.outcome).toBe('ran');
		if (outcome.outcome === 'ran') {
			expect(outcome.result.exitCode).toBe(0);
			expect(outcome.result.stdout).toBe('one\nthree\n');
			expect(outcome.result.stderr).toBe('two\n');
			expect(outcome.result.combined).toContain('one');
			expect(outcome.result.combined).toContain('two');
		}
	});

	it('passes argv through untouched — spaces and shell metacharacters stay literal', async () => {
		const dir = makeBinDir();
		const argsFile = join(dir, 'recorded');
		const bin = writeFakeBin(
			dir,
			'recorder',
			`for a in "$@"; do printf '%s\\n' "$a"; done > "${argsFile}"`,
		);
		const tricky = [
			'/path/with spaces/proj',
			'$(rm -rf /)',
			'a;b|c',
			'"quoted"',
		];
		await runCommand(bin, tricky);
		expect(readFileSync(argsFile, 'utf8')).toBe(`${tricky.join('\n')}\n`);
	});

	it('streams chunks to onOutput as they arrive', async () => {
		const bin = writeFakeBin(makeBinDir(), 'streamer', 'echo a\necho b >&2');
		const chunks: Array<[string, string]> = [];
		await runCommand(bin, [], {
			onOutput: (stream, chunk) => chunks.push([stream, chunk]),
		});
		expect(chunks).toContainEqual(['stdout', 'a\n']);
		expect(chunks).toContainEqual(['stderr', 'b\n']);
	});

	it('reports the exit code of a failing command', async () => {
		const bin = writeFakeBin(makeBinDir(), 'failer', 'exit 42');
		const outcome = await runCommand(bin, []);
		expect(outcome).toMatchObject({
			outcome: 'ran',
			result: { exitCode: 42, interrupted: false },
		});
	});

	it('reports spawn failure for a missing executable', async () => {
		const outcome = await runCommand(join(makeBinDir(), 'ghost'), []);
		expect(outcome.outcome).toBe('spawn-failed');
	});

	it('marks the run interrupted when the child dies by signal', async () => {
		const bin = writeFakeBin(makeBinDir(), 'sleeper', 'exec /bin/sleep 30');
		const promise = runCommand(bin, []);
		// Give the child a moment to start, then simulate Ctrl+C reaching it.
		setTimeout(() => process.emit('SIGINT'), 100);
		const outcome = await promise;
		expect(outcome.outcome).toBe('ran');
		if (outcome.outcome === 'ran') {
			expect(outcome.result.interrupted).toBe(true);
		}
	});
});

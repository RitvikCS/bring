import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeCommand } from '../../src/adapters/probe-command.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

describe('probeCommand', () => {
	it('captures stdout and exit code 0', async () => {
		const bin = writeFakeBin(makeBinDir(), 'ok', 'echo "0.87.0"');
		const result = await probeCommand(bin, ['--version']);
		expect(result).toEqual({
			outcome: 'completed',
			exitCode: 0,
			stdout: '0.87.0\n',
			stderr: '',
		});
	});

	it('captures stderr and a non-zero exit code', async () => {
		const bin = writeFakeBin(
			makeBinDir(),
			'grumpy',
			'echo "cannot connect" >&2\nexit 7',
		);
		const result = await probeCommand(bin, []);
		expect(result).toMatchObject({
			outcome: 'completed',
			exitCode: 7,
			stderr: 'cannot connect\n',
		});
	});

	it('terminates a hanging process at the deadline', async () => {
		const bin = writeFakeBin(makeBinDir(), 'hang', 'exec /bin/sleep 30');
		const startedAt = Date.now();
		const result = await probeCommand(bin, [], { timeoutMs: 200 });
		expect(result).toEqual({ outcome: 'timed-out', timeoutMs: 200 });
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it('reports a spawn failure for a missing executable', async () => {
		const missing = join(makeBinDir(), 'does-not-exist');
		const result = await probeCommand(missing, ['--version']);
		expect(result.outcome).toBe('spawn-failed');
	});
});

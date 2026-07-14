import { beforeEach, describe, expect, it } from 'vitest';
import {
	clearCapabilityCache,
	detectDevcontainerCapabilities,
	parseDevcontainerCapabilities,
} from '../../src/adapters/devcontainer-capabilities.js';
import {
	HEALTHY_DEVCONTAINER,
	makeBinDir,
	writeFakeBin,
} from '../helpers/fake-bin.js';

const FULL_HELP = `Commands:
  devcontainer up                     Create and run dev container
  devcontainer set-up                 Set up an existing container
  devcontainer read-configuration     Read configuration
  devcontainer upgrade                Upgrade lockfile
  devcontainer exec <cmd> [args..]    Execute a command`;

describe('parseDevcontainerCapabilities', () => {
	it('finds every required command in full help output', () => {
		const result = parseDevcontainerCapabilities(FULL_HELP);
		expect(result.missing).toEqual([]);
		expect(result.commands).toEqual(['up', 'exec', 'read-configuration']);
	});

	it('reports exactly the commands the help output lacks', () => {
		const partial = FULL_HELP.split('\n')
			.filter((line) => !/\b(exec|read-configuration)\b/.test(line))
			.join('\n');
		const result = parseDevcontainerCapabilities(partial);
		expect(result.missing).toEqual(['exec', 'read-configuration']);
	});

	it('does not mistake prefixed commands like upgrade for up', () => {
		const result = parseDevcontainerCapabilities(
			'Commands:\n  devcontainer upgrade    Upgrade lockfile',
		);
		expect(result.commands).toEqual([]);
	});
});

describe('detectDevcontainerCapabilities', () => {
	beforeEach(() => {
		clearCapabilityCache();
	});

	it('detects capabilities from a fake CLI', async () => {
		const bin = writeFakeBin(
			makeBinDir(),
			'devcontainer',
			HEALTHY_DEVCONTAINER,
		);
		const detection = await detectDevcontainerCapabilities(bin);
		expect(detection).toMatchObject({
			outcome: 'detected',
			capabilities: { missing: [] },
		});
	});

	it('caches per executable for the current process', async () => {
		const dir = makeBinDir();
		const bin = writeFakeBin(dir, 'devcontainer', HEALTHY_DEVCONTAINER);
		const first = await detectDevcontainerCapabilities(bin);
		// Break the fake: a cached detection must not re-probe it.
		writeFakeBin(dir, 'devcontainer', 'echo "no commands here"');
		const second = await detectDevcontainerCapabilities(bin);
		expect(second).toBe(first);

		clearCapabilityCache();
		const third = await detectDevcontainerCapabilities(bin);
		expect(third.outcome).toBe('probe-failed');
	});

	it('fails the probe when --help hangs', async () => {
		const bin = writeFakeBin(
			makeBinDir(),
			'devcontainer',
			'exec /bin/sleep 30',
		);
		const detection = await detectDevcontainerCapabilities(bin, {
			timeoutMs: 200,
		});
		expect(detection.outcome).toBe('probe-failed');
	});
});

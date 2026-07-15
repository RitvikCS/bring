import { describe, expect, it } from 'vitest';
import {
	detectUpFlags,
	execArgv,
	parseUpResult,
	readConfigurationArgv,
	upArgv,
} from '../../src/adapters/devcontainer-cli.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

describe('argv builders', () => {
	it('builds up argv with the workspace folder', () => {
		expect(upArgv('/proj/with space')).toEqual([
			'up',
			'--workspace-folder',
			'/proj/with space',
		]);
	});

	it('appends config and rebuild flags when requested', () => {
		expect(
			upArgv('/p', {
				config: '/p/.devcontainer/alt/devcontainer.json',
				removeExistingContainer: true,
				buildNoCache: true,
			}),
		).toEqual([
			'up',
			'--workspace-folder',
			'/p',
			'--config',
			'/p/.devcontainer/alt/devcontainer.json',
			'--remove-existing-container',
			'--build-no-cache',
		]);
	});

	it('builds exec argv with the command appended verbatim', () => {
		expect(execArgv('/p', ['bash', '-c', 'echo $(hostname)'])).toEqual([
			'exec',
			'--workspace-folder',
			'/p',
			'bash',
			'-c',
			'echo $(hostname)',
		]);
	});

	it('builds read-configuration argv', () => {
		expect(readConfigurationArgv('/p')).toEqual([
			'read-configuration',
			'--workspace-folder',
			'/p',
		]);
	});
});

describe('parseUpResult', () => {
	it('finds the JSON result line among build noise', () => {
		const stdout = [
			'[+] Building 1.2s',
			'Container started',
			'{"outcome":"success","containerId":"abc123","remoteWorkspaceFolder":"/workspaces/p"}',
		].join('\n');
		expect(parseUpResult(stdout)).toMatchObject({
			outcome: 'success',
			containerId: 'abc123',
		});
	});

	it('returns null when no success JSON is present', () => {
		expect(parseUpResult('plain logs only\n')).toBeNull();
		expect(parseUpResult('{"outcome":"error","message":"boom"}\n')).toBeNull();
	});
});

describe('detectUpFlags', () => {
	it('detects both rebuild flags from up --help', async () => {
		const bin = writeFakeBin(
			makeBinDir(),
			'devcontainer',
			`echo "Options:"
echo "  --remove-existing-container  Remove the existing container"
echo "  --build-no-cache             Build without cache"`,
		);
		expect(await detectUpFlags(bin)).toEqual({ replace: true, noCache: true });
	});

	it('reports missing flags', async () => {
		const bin = writeFakeBin(makeBinDir(), 'devcontainer', 'echo "Options:"');
		expect(await detectUpFlags(bin)).toEqual({
			replace: false,
			noCache: false,
		});
	});
});

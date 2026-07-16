import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	listWorkspaceContainers,
	parsePorts,
	parsePsLines,
	removeContainers,
	stopContainers,
} from '../../src/adapters/docker-cli.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

const PS_LINE =
	'{"ID":"abc123","Names":"vsc-proj-x","State":"running","Status":"Up 2 hours","Image":"vsc-proj-uid","Ports":"0.0.0.0:8080->80/tcp, :::8080->80/tcp"}';

describe('parsePsLines', () => {
	it('parses one container per JSON line and skips junk', () => {
		const containers = parsePsLines(`${PS_LINE}\nnot json\n\n`);
		expect(containers).toEqual([
			{
				id: 'abc123',
				name: 'vsc-proj-x',
				state: 'running',
				statusText: 'Up 2 hours',
				image: 'vsc-proj-uid',
				ports: [{ containerPort: 80, hostPort: 8080 }],
			},
		]);
	});

	it('returns an empty list for empty output', () => {
		expect(parsePsLines('')).toEqual([]);
	});
});

describe('parsePorts', () => {
	it('deduplicates IPv4/IPv6 mappings and keeps unpublished ports', () => {
		expect(
			parsePorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 3000/tcp'),
		).toEqual([{ containerPort: 80, hostPort: 8080 }, { containerPort: 3000 }]);
	});

	it('handles an empty field', () => {
		expect(parsePorts('')).toEqual([]);
	});
});

describe('docker adapter commands', () => {
	function recordingDocker(dir: string, extra = 'exit 0'): string {
		return writeFakeBin(
			dir,
			'docker',
			`printf '%s\\n' "$@" > "${join(dir, 'argv')}"\n${extra}`,
		);
	}

	it('lists containers filtered by the workspace label', async () => {
		const dir = makeBinDir();
		const bin = recordingDocker(dir, `echo '${PS_LINE}'`);
		const result = await listWorkspaceContainers(bin, '/home/me/proj x');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe('abc123');
		}
		expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe(
			'ps\n--all\n--filter\nlabel=devcontainer.local_folder=/home/me/proj x\n--format\n{{json .}}\n',
		);
	});

	it('stops and removes by id with exact argv', async () => {
		const dir = makeBinDir();
		const bin = recordingDocker(dir);
		await stopContainers(bin, ['a1', 'b2']);
		expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe('stop\na1\nb2\n');
		await removeContainers(bin, ['a1']);
		expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe('rm\na1\n');
	});

	it('surfaces stderr when docker fails', async () => {
		const dir = makeBinDir();
		const bin = writeFakeBin(dir, 'docker', 'echo "boom" >&2\nexit 1');
		const result = await listWorkspaceContainers(bin, '/p');
		expect(result).toEqual({ ok: false, message: 'boom' });
	});
});

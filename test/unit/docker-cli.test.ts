import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	listAllContainers,
	listDevContainerImages,
	listWorkspaceContainers,
	parseContainerListLines,
	parseImageListLines,
	parsePorts,
	parsePsLines,
	removeContainers,
	removeImages,
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

describe('resource inventory parsing', () => {
	it('parses the stable fields from container and image list rows', () => {
		expect(parseContainerListLines(PS_LINE)).toEqual([
			{
				id: 'abc123',
				name: 'vsc-proj-x',
				state: 'running',
				statusText: 'Up 2 hours',
				createdAt: '',
				imageName: 'vsc-proj-uid',
				ports: [{ containerPort: 80, hostPort: 8080 }],
			},
		]);
		expect(
			parseImageListLines(
				'{"ID":"sha256:one","Repository":"vsc-proj","Tag":"latest"}\nwarning',
			),
		).toEqual([{ id: 'sha256:one' }]);
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
		await removeImages(bin, ['sha256:i1', 'sha256:i2']);
		expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe(
			'image\nrm\n--no-prune\nsha256:i1\nsha256:i2\n',
		);
	});

	it('inspects all containers for exact labels and image ids', async () => {
		const dir = makeBinDir();
		const bin = writeFakeBin(
			dir,
			'docker',
			`case "$1 $2" in
				"ps --all") echo '${PS_LINE}' ;;
				"container inspect") echo '[{"Id":"abc123","Name":"/vsc-proj-x","Created":"2026-07-16T12:00:00Z","Image":"sha256:image","Config":{"Image":"vsc-proj-uid","Labels":{"devcontainer.local_folder":"/work/proj"}}}]' ;;
			esac`,
		);
		const result = await listAllContainers(bin);
		expect(result).toEqual({
			ok: true,
			value: [
				{
					id: 'abc123',
					name: 'vsc-proj-x',
					state: 'running',
					statusText: 'Up 2 hours',
					createdAt: '2026-07-16T12:00:00Z',
					imageId: 'sha256:image',
					imageName: 'vsc-proj-uid',
					ports: [{ containerPort: 80, hostPort: 8080 }],
					labels: { 'devcontainer.local_folder': '/work/proj' },
				},
			],
		});
	});

	it('lists metadata-labelled images plus additional container images', async () => {
		const dir = makeBinDir();
		const bin = writeFakeBin(
			dir,
			'docker',
			`case "$1 $2" in
				"image ls")
					echo '{"ID":"sha256:meta","Repository":"vsc-proj","Tag":"latest"}'
					;;
				"image inspect")
					echo '[{"Id":"sha256:meta","Created":"2026-07-16T12:00:00Z","RepoTags":["vsc-proj:latest"],"Size":1200,"RootFS":{"Layers":["layer-a"]}},{"Id":"sha256:used","Created":"2026-07-15T12:00:00Z","RepoTags":null,"Size":800,"RootFS":{"Layers":["layer-a","layer-b"]}},{"Id":"sha256:unrelated","Created":"2026-07-14T12:00:00Z","RepoTags":["postgres:latest"],"Size":700,"RootFS":{"Layers":["layer-c"]}}]'
					;;
			esac`,
		);
		const result = await listDevContainerImages(bin, ['sha256:used'], {
			lineageImageIds: ['sha256:unrelated'],
		});
		expect(result).toEqual({
			ok: true,
			value: {
				images: [
					{
						id: 'sha256:meta',
						references: ['vsc-proj:latest'],
						displayName: 'vsc-proj:latest',
						createdAt: '2026-07-16T12:00:00Z',
						sizeBytes: 1200,
						dangling: false,
					},
					{
						id: 'sha256:used',
						references: [],
						displayName: '<none>:<none>',
						createdAt: '2026-07-15T12:00:00Z',
						sizeBytes: 800,
						dangling: true,
					},
				],
				layerIdsByImageId: {
					'sha256:meta': ['layer-a'],
					'sha256:used': ['layer-a', 'layer-b'],
					'sha256:unrelated': ['layer-c'],
				},
			},
		});
	});

	it('surfaces stderr when docker fails', async () => {
		const dir = makeBinDir();
		const bin = writeFakeBin(dir, 'docker', 'echo "boom" >&2\nexit 1');
		const result = await listWorkspaceContainers(bin, '/p');
		expect(result).toEqual({ ok: false, message: 'boom' });
	});
});

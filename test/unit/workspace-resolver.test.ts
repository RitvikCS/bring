import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	resolveWorkspace,
	workspaceIdentity,
} from '../../src/core/workspace-resolver.js';

function makeProject(structure: {
	dotDir?: boolean;
	dotFile?: boolean;
	name?: string;
}): string {
	const root = mkdtempSync(
		join(tmpdir(), `bring-ws-${structure.name ?? 'p'}-`),
	);
	if (structure.dotDir) {
		mkdirSync(join(root, '.devcontainer'));
		writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
	}
	if (structure.dotFile) {
		writeFileSync(join(root, '.devcontainer.json'), '{}\n');
	}
	return root;
}

describe('resolveWorkspace', () => {
	it.each([
		'.',
		'this',
		'',
	])('resolves %j to the current directory', (input) => {
		const root = makeProject({ dotDir: true });
		const result = resolveWorkspace(input, { cwd: root });
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: {
				rootPath: root,
				configPath: join(root, '.devcontainer', 'devcontainer.json'),
			},
		});
	});

	it('resolves a relative path against cwd', () => {
		const root = makeProject({ dotFile: true });
		const inside = join(root, 'src');
		mkdirSync(inside);
		const result = resolveWorkspace('..', { cwd: inside });
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: {
				rootPath: root,
				configPath: join(root, '.devcontainer.json'),
			},
		});
	});

	it('walks upward to the nearest ancestor with a config', () => {
		const root = makeProject({ dotDir: true });
		const deep = join(root, 'src', 'components');
		mkdirSync(deep, { recursive: true });
		const result = resolveWorkspace('.', { cwd: deep });
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { rootPath: root },
		});
	});

	it('prefers the nearest config when ancestors also have one', () => {
		const outer = makeProject({ dotDir: true });
		const inner = join(outer, 'service');
		mkdirSync(join(inner, '.devcontainer'), { recursive: true });
		writeFileSync(join(inner, '.devcontainer', 'devcontainer.json'), '{}\n');
		const result = resolveWorkspace('.', { cwd: inner });
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { rootPath: inner },
		});
	});

	it('reports ambiguity when both config locations exist', () => {
		const root = makeProject({ dotDir: true, dotFile: true });
		const result = resolveWorkspace('.', { cwd: root });
		expect(result).toMatchObject({
			outcome: 'ambiguous',
			problem: { code: 'CONFIG_AMBIGUOUS' },
		});
		if (result.outcome === 'ambiguous') {
			expect(result.configs).toHaveLength(2);
		}
	});

	it('an explicit --config overrides ambiguity', () => {
		const root = makeProject({ dotDir: true, dotFile: true });
		const result = resolveWorkspace('.', {
			cwd: root,
			explicitConfig: '.devcontainer.json',
		});
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { configPath: join(root, '.devcontainer.json') },
		});
	});

	it('reports a missing explicit config as CONFIG_NOT_FOUND', () => {
		const root = makeProject({ dotDir: true });
		const result = resolveWorkspace('.', {
			cwd: root,
			explicitConfig: 'nope/devcontainer.json',
		});
		expect(result).toMatchObject({
			outcome: 'no-config',
			problem: { code: 'CONFIG_NOT_FOUND' },
		});
	});

	it('reports no-config when nothing is found up to the root', () => {
		const bare = mkdtempSync(join(tmpdir(), 'bring-ws-bare-'));
		const result = resolveWorkspace('.', { cwd: bare });
		expect(result).toMatchObject({
			outcome: 'no-config',
			problem: { code: 'CONFIG_NOT_FOUND' },
		});
	});

	it('reports a nonexistent target as WORKSPACE_NOT_FOUND', () => {
		const bare = mkdtempSync(join(tmpdir(), 'bring-ws-bare-'));
		const result = resolveWorkspace('./ghost', { cwd: bare });
		expect(result).toMatchObject({
			outcome: 'not-found',
			problem: { code: 'WORKSPACE_NOT_FOUND' },
		});
	});

	it('resolves symlinks so identity is stable', () => {
		const root = makeProject({ dotDir: true });
		const linkParent = mkdtempSync(join(tmpdir(), 'bring-ws-link-'));
		const link = join(linkParent, 'alias');
		symlinkSync(root, link);
		const direct = resolveWorkspace(root, { cwd: '/' });
		const viaLink = resolveWorkspace(link, { cwd: '/' });
		expect(direct).toMatchObject({ outcome: 'resolved' });
		expect(viaLink).toMatchObject({ outcome: 'resolved' });
		if (direct.outcome === 'resolved' && viaLink.outcome === 'resolved') {
			expect(viaLink.workspace.rootPath).toBe(direct.workspace.rootPath);
			expect(viaLink.workspace.identity).toBe(direct.workspace.identity);
		}
	});

	it('handles paths containing spaces', () => {
		const parent = mkdtempSync(join(tmpdir(), 'bring-ws-space-'));
		const root = join(parent, 'my cool project');
		mkdirSync(join(root, '.devcontainer'), { recursive: true });
		writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
		const result = resolveWorkspace(root, { cwd: '/' });
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { rootPath: root },
		});
	});
});

describe('workspaceIdentity', () => {
	it('is deterministic and path-sensitive', () => {
		expect(workspaceIdentity('/a/b')).toBe(workspaceIdentity('/a/b'));
		expect(workspaceIdentity('/a/b')).not.toBe(workspaceIdentity('/a/c'));
		expect(workspaceIdentity('/a/b')).toMatch(/^[0-9a-f]{16}$/);
	});
});

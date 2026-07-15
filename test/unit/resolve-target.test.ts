import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTarget } from '../../src/application/resolve-target.js';
import { rememberWorkspace } from '../../src/stores/workspace-store.js';

function makeAmbiguousProject(): string {
	const root = mkdtempSync(join(tmpdir(), 'bring-rt-'));
	mkdirSync(join(root, '.devcontainer'));
	writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
	writeFileSync(join(root, '.devcontainer.json'), '{}\n');
	return root;
}

function tempStateFile(): string {
	return join(mkdtempSync(join(tmpdir(), 'bring-rt-state-')), 'state.json');
}

describe('resolveTarget', () => {
	it('stays ambiguous when nothing was remembered', () => {
		const root = makeAmbiguousProject();
		const { result, usedRememberedConfig } = resolveTarget('.', {
			cwd: root,
			stateFile: tempStateFile(),
		});
		expect(result.outcome).toBe('ambiguous');
		expect(usedRememberedConfig).toBeUndefined();
	});

	it('settles ambiguity with the remembered last --config choice', () => {
		const root = makeAmbiguousProject();
		const stateFile = tempStateFile();
		const chosen = join(root, '.devcontainer.json');
		rememberWorkspace(stateFile, { rootPath: root, configPath: chosen });

		const { result, usedRememberedConfig } = resolveTarget('.', {
			cwd: root,
			stateFile,
		});
		expect(usedRememberedConfig).toBe(chosen);
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { rootPath: root, configPath: chosen },
		});
	});

	it('an explicit --config always beats the memory', () => {
		const root = makeAmbiguousProject();
		const stateFile = tempStateFile();
		rememberWorkspace(stateFile, {
			rootPath: root,
			configPath: join(root, '.devcontainer.json'),
		});

		const explicit = join('.devcontainer', 'devcontainer.json');
		const { result, usedRememberedConfig } = resolveTarget('.', {
			cwd: root,
			explicitConfig: explicit,
			stateFile,
		});
		expect(usedRememberedConfig).toBeUndefined();
		expect(result).toMatchObject({
			outcome: 'resolved',
			workspace: { configPath: join(root, explicit) },
		});
	});

	it('ignores a remembered config that is no longer a candidate', () => {
		const root = makeAmbiguousProject();
		const stateFile = tempStateFile();
		rememberWorkspace(stateFile, {
			rootPath: root,
			configPath: join(root, '.devcontainer', 'gone', 'devcontainer.json'),
		});

		const { result, usedRememberedConfig } = resolveTarget('.', {
			cwd: root,
			stateFile,
		});
		expect(result.outcome).toBe('ambiguous');
		expect(usedRememberedConfig).toBeUndefined();
	});

	it('does not interfere with unambiguous resolution', () => {
		const root = mkdtempSync(join(tmpdir(), 'bring-rt-plain-'));
		writeFileSync(join(root, '.devcontainer.json'), '{}\n');
		const { result, usedRememberedConfig } = resolveTarget('.', {
			cwd: root,
			stateFile: tempStateFile(),
		});
		expect(result.outcome).toBe('resolved');
		expect(usedRememberedConfig).toBeUndefined();
	});
});

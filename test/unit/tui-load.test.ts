import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	rememberWorkspace,
	stateFilePath,
} from '../../src/stores/workspace-store.js';
import { interestingLogLine, realEnvironment } from '../../src/tui/load.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

// The TUI's data loading (current-folder affordance): a project the
// registry has never seen still shows up when the TUI is opened inside it.

function makeProject(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'bring-tui-proj-')));
	mkdirSync(join(root, '.devcontainer'));
	writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
	return root;
}

function makeEnv(): NodeJS.ProcessEnv {
	const binDir = makeBinDir();
	// docker ps returns nothing: any workspace resolves to not-created.
	writeFakeBin(binDir, 'docker', 'case "$1" in ps) : ;; *) : ;; esac');
	writeFakeBin(binDir, 'devcontainer', ':');
	const stateHome = mkdtempSync(join(tmpdir(), 'bring-tui-state-'));
	return { PATH: binDir, XDG_STATE_HOME: stateHome };
}

describe('loadWorkspaces current-folder affordance', () => {
	it('lists an unregistered cwd project so first contact is never empty', async () => {
		const env = makeEnv();
		const project = makeProject();
		const environment = realEnvironment(env, project);
		const listed = await environment.loadWorkspaces();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			unregistered: true,
			status: 'not-created',
		});
		expect(listed[0]?.ref.rootPath).toBe(project);
	});

	it('does not duplicate a cwd project that is already registered', async () => {
		const env = makeEnv();
		const project = makeProject();
		rememberWorkspace(stateFilePath(env), {
			rootPath: project,
			configPath: join(project, '.devcontainer', 'devcontainer.json'),
		});
		const environment = realEnvironment(env, project);
		const listed = await environment.loadWorkspaces();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.unregistered).toBeUndefined();
	});

	it('adds nothing when the cwd has no configuration', async () => {
		const env = makeEnv();
		const emptyDir = realpathSync(mkdtempSync(join(tmpdir(), 'bring-empty-')));
		const environment = realEnvironment(env, emptyDir);
		const listed = await environment.loadWorkspaces();
		expect(listed).toEqual([]);
	});
});

describe('interestingLogLine (detail-pane tail filter)', () => {
	it('drops bare timestamps and the outcome JSON, keeps real content', () => {
		expect(interestingLogLine('[2026-07-16T17:05:34.115Z]')).toBe(false);
		expect(interestingLogLine('{"outcome":"success","containerId":"a"}')).toBe(
			false,
		);
		expect(interestingLogLine('   ')).toBe(false);
		expect(interestingLogLine('Step 5/9 : RUN pip install')).toBe(true);
		expect(interestingLogLine('[2026-07-16T17:05:34.115Z] Running…')).toBe(
			true,
		);
	});
});

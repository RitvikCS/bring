import {
	cpSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findExecutable } from '../../src/adapters/find-executable.js';
import { runCommand } from '../../src/adapters/process-runner.js';
import { bringDown } from '../../src/application/bring-down.js';
import { bringUp } from '../../src/application/bring-up.js';
import type { OperationContext } from '../../src/application/context.js';
import { getSnapshot } from '../../src/application/get-status.js';
import { removeImageResources } from '../../src/application/image-actions.js';
import { listResources } from '../../src/application/list-resources.js';
import { openShell } from '../../src/application/open-shell.js';
import type { WorkspaceRef } from '../../src/core/types.js';
import { workspaceIdentity } from '../../src/core/workspace-resolver.js';
import { readLatestLog } from '../../src/stores/log-store.js';
import { bringStateDir } from '../../src/stores/paths.js';
import { stateFilePath } from '../../src/stores/workspace-store.js';

// Phase 1G (P1-44/45/46): the real lifecycle through the actual Dev
// Containers CLI and Docker. Gated behind BRING_INTEGRATION=1 because it
// pulls images and creates real containers — `npm run test:integration`.
// Each fixture is copied to a temp directory first, so container labels and
// the registry never point into the repository.

const RUN = process.env.BRING_INTEGRATION === '1';
const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const MINUTES = 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) {
		await cleanup();
	}
});

interface Project {
	ctx: OperationContext;
	ref: WorkspaceRef;
}

function prepare(fixture: string): Project {
	const devcontainerExe = findExecutable('devcontainer', process.env.PATH);
	const dockerExe = findExecutable('docker', process.env.PATH);
	if (devcontainerExe === null || dockerExe === null) {
		throw new Error(
			'Integration tests need `devcontainer` and `docker` on PATH.',
		);
	}
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), `bring-it-${fixture}-`)),
	);
	cpSync(join(FIXTURES, fixture), root, { recursive: true });
	const stateHome = mkdtempSync(join(tmpdir(), 'bring-it-state-'));
	const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: stateHome };
	const ref: WorkspaceRef = {
		input: root,
		rootPath: root,
		configPath: join(root, '.devcontainer', 'devcontainer.json'),
		identity: workspaceIdentity(root),
	};
	const ctx: OperationContext = {
		devcontainerExe,
		dockerExe,
		stateDir: bringStateDir(env),
		stateFile: stateFilePath(env),
		env,
		emit: () => {},
	};
	cleanups.push(async () => {
		// Belt and braces: even if a test failed mid-way, no fixture
		// container (including a Compose sidecar) survives the run.
		const inventory = await listResources({
			dockerExe,
			env,
			includeImages: false,
			knownWorkspacePaths: [root],
		});
		if (inventory.ok) {
			const ids = inventory.inventory.containers
				.filter((container) => container.workspacePath === root)
				.map((container) => container.id);
			if (ids.length > 0) {
				await runCommand(dockerExe, ['rm', '--force', ...ids]);
			}
		}
		rmSync(root, { recursive: true, force: true });
		rmSync(stateHome, { recursive: true, force: true });
	});
	return { ctx, ref };
}

describe.runIf(RUN)('minimal fixture lifecycle (P1-44)', () => {
	it(
		'up → idempotent up → exec → down → remove, source files untouched',
		async () => {
			const { ctx, ref } = prepare('minimal');
			const listFiles = () =>
				(readdirSync(ref.rootPath, { recursive: true }) as string[]).sort();
			const filesBefore = listFiles();

			const up = await bringUp(ctx, ref, { config: ref.configPath });
			expect(up.outcome).toBe('success');
			expect(up.containerIds.length).toBeGreaterThan(0);

			const running = await getSnapshot(ctx, ref);
			expect(running.ok && running.snapshot.status).toBe('running');

			const again = await bringUp(ctx, ref, { config: ref.configPath });
			expect(again.outcome).toBe('success');
			expect(again.message).toContain('already running');

			const shell = await openShell(
				ctx,
				ref,
				['bash', '-lc', 'echo bring-integration-ok'],
				ref.configPath,
			);
			expect(shell.outcome).toBe('success');
			expect(shell.childExitCode).toBe(0);

			const down = await bringDown(ctx, ref);
			expect(down.outcome).toBe('success');
			const stopped = await getSnapshot(ctx, ref);
			expect(stopped.ok && stopped.snapshot.status).toBe('stopped');

			const removed = await bringDown(ctx, ref, { remove: true });
			expect(removed.outcome).toBe('success');
			const gone = await getSnapshot(ctx, ref);
			expect(gone.ok && gone.snapshot.status).toBe('not-created');
			const afterRemove = await listResources({
				dockerExe: ctx.dockerExe,
				env: ctx.env,
				includeImages: false,
				knownWorkspacePaths: [ref.rootPath],
			});
			expect(
				afterRemove.ok
					? afterRemove.inventory.containers.filter(
							(container) => container.workspacePath === ref.rootPath,
						)
					: [afterRemove.problem],
			).toEqual([]);

			expect(readLatestLog(ctx.stateDir, ref.identity)).not.toBeNull();
			expect(listFiles()).toEqual(filesBefore);
		},
		10 * MINUTES,
	);
});

describe.runIf(RUN)('compose fixture lifecycle (P1-45)', () => {
	it(
		'up → related app/sidecar inventory → down → remove',
		async () => {
			const { ctx, ref } = prepare('compose');

			const up = await bringUp(ctx, ref, { config: ref.configPath });
			expect(up.outcome).toBe('success');

			const running = await getSnapshot(ctx, ref);
			expect(running.ok && running.snapshot.status).toBe('running');

			const inventory = await listResources({
				dockerExe: ctx.dockerExe,
				env: ctx.env,
			});
			expect(inventory.ok).toBe(true);
			if (!inventory.ok) {
				throw new Error(inventory.problem.summary);
			}
			const containers = inventory.inventory.containers.filter(
				(container) => container.workspacePath === ref.rootPath,
			);
			expect(containers).toHaveLength(2);
			expect(containers.map((container) => container.role).sort()).toEqual([
				'primary',
				'service',
			]);
			expect(
				containers.find((container) => container.role === 'service')
					?.serviceName,
			).toBe('db');

			const workspaceImage = inventory.inventory.images.find((image) =>
				image.workspacePaths.includes(ref.rootPath),
			);
			expect(workspaceImage?.inUse).toBe(true);
			if (workspaceImage !== undefined) {
				const blocked = await removeImageResources(ctx, [workspaceImage]);
				expect(blocked.ok).toBe(false);
			}

			const down = await bringDown(ctx, ref);
			expect(down.outcome).toBe('success');

			const removed = await bringDown(ctx, ref, { remove: true });
			expect(removed.outcome).toBe('success');
			const gone = await getSnapshot(ctx, ref);
			expect(gone.ok && gone.snapshot.status).toBe('not-created');
		},
		10 * MINUTES,
	);
});

describe.runIf(RUN)('failing fixture (P1-46)', () => {
	it(
		'a failing postCreateCommand yields a concise problem and a full log',
		async () => {
			const { ctx, ref } = prepare('failing');

			const up = await bringUp(ctx, ref, { config: ref.configPath });
			expect(up.outcome).toBe('failed');
			expect(up.problem).toBeDefined();
			expect(up.problem?.summary).toBeTruthy();

			const log = readLatestLog(ctx.stateDir, ref.identity);
			expect(log).not.toBeNull();
			expect(log).toContain('fixture-doom');

			// The half-built container is still removable.
			const removed = await bringDown(ctx, ref, { remove: true });
			expect(removed.outcome).toBe('success');
		},
		10 * MINUTES,
	);
});

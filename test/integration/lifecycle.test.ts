import { spawn, spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findExecutable } from '../../src/adapters/find-executable.js';
import { runCommand } from '../../src/adapters/process-runner.js';
import { bringDown } from '../../src/application/bring-down.js';
import { bringUp } from '../../src/application/bring-up.js';
import type { OperationContext } from '../../src/application/context.js';
import {
	execCommand,
	startDetached,
} from '../../src/application/exec-command.js';
import {
	bridgeArgv,
	startForwarding,
} from '../../src/application/forward-ports.js';
import { getSnapshot } from '../../src/application/get-status.js';
import { removeImageResources } from '../../src/application/image-actions.js';
import { listResources } from '../../src/application/list-resources.js';
import { openShell } from '../../src/application/open-shell.js';
import { isImagePruneCandidate } from '../../src/core/resources.js';
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

			const workspaceImage = (inventory.inventory.images ?? []).find((image) =>
				image.workspacePaths.includes(ref.rootPath),
			);
			expect(workspaceImage?.usage).toBe('attached');
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

describe.runIf(RUN)('image lineage safety (Phase 2)', () => {
	it(
		'classifies a labelled base as cached when a running image descends from it',
		async () => {
			const { ctx, ref } = prepare('minimal');
			const suffix = basename(ref.rootPath).toLowerCase();
			const baseTag = `bring-it-lineage-base-${suffix}:test`;
			const derivedTag = `bring-it-lineage-derived-${suffix}:test`;
			const containerName = `bring-it-lineage-${suffix}`;
			const fixture = join(FIXTURES, 'lineage');

			// The workspace cleanup runs first, then these test-owned image tags go.
			cleanups.unshift(async () => {
				await runCommand(ctx.dockerExe, ['rm', '--force', containerName], {
					env: ctx.env,
				});
				await runCommand(ctx.dockerExe, ['image', 'rm', derivedTag, baseTag], {
					env: ctx.env,
				});
			});

			await expectDockerSuccess(ctx, [
				'build',
				'--file',
				join(fixture, 'base.Dockerfile'),
				'--tag',
				baseTag,
				fixture,
			]);
			await expectDockerSuccess(ctx, [
				'build',
				'--file',
				join(fixture, 'derived.Dockerfile'),
				'--build-arg',
				`BASE_IMAGE=${baseTag}`,
				'--tag',
				derivedTag,
				fixture,
			]);
			await expectDockerSuccess(ctx, [
				'run',
				'--detach',
				'--name',
				containerName,
				'--label',
				`devcontainer.local_folder=${ref.rootPath}`,
				derivedTag,
				'sleep',
				'infinity',
			]);

			const result = await listResources({
				dockerExe: ctx.dockerExe,
				env: ctx.env,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) {
				throw new Error(result.problem.summary);
			}
			const images = result.inventory.images ?? [];
			const base = images.find((image) => image.references.includes(baseTag));
			const derived = images.find((image) =>
				image.references.includes(derivedTag),
			);
			expect(base).toMatchObject({
				usage: 'base',
				containerNames: [],
				descendantContainerNames: expect.arrayContaining([containerName]),
				workspacePaths: expect.arrayContaining([ref.rootPath]),
			});
			if (base === undefined) {
				throw new Error('The lineage base image was not discovered.');
			}
			expect(isImagePruneCandidate(base)).toBe(false);
			expect(derived?.usage).toBe('attached');
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

async function expectDockerSuccess(
	ctx: OperationContext,
	args: readonly string[],
): Promise<void> {
	const outcome = await runCommand(ctx.dockerExe, args, { env: ctx.env });
	if (outcome.outcome !== 'ran') {
		throw new Error(outcome.message);
	}
	if (outcome.result.exitCode !== 0) {
		throw new Error(outcome.result.stderr || outcome.result.stdout);
	}
}

describe.runIf(RUN)('exec against a real container (Phase 4)', () => {
	// debian-slim has no `ps`: count matching processes through /proc. The
	// `[s]` keeps the counting script from matching itself.
	const count = async (project: Project, pattern: string): Promise<number> => {
		const result = await execCommand(project.ctx, project.ref, [
			'sh',
			'-c',
			`for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "${pattern}" || true`,
		]);
		// A failed count must fail the test, not read as "0 left".
		expect(result).toMatchObject({ outcome: 'success', exitCode: 0 });
		expect(result.stdout.trim()).toMatch(/^\d+$/);
		return Number(result.stdout.trim());
	};

	it(
		'captures output, passes exit codes through, and leaves no orphans on timeout or detach-stop',
		async () => {
			const project = prepare('minimal');
			const { ctx, ref } = project;
			const up = await bringUp(ctx, ref, { config: ref.configPath });
			expect(up.outcome).toBe('success');

			const ran = await execCommand(ctx, ref, [
				'sh',
				'-c',
				'echo hi; echo err >&2; exit 3',
			]);
			expect(ran).toMatchObject({
				outcome: 'success',
				exitCode: 3,
				stdout: 'hi\n',
				stderr: 'err\n',
			});

			// Killing the host-side exec alone would leave these running in
			// the container (verified 2026-11-03) — including the one that
			// moves to its own session, which a process-group kill misses.
			const timedOut = await execCommand(
				ctx,
				ref,
				['sh', '-c', 'setsid sleep 71 & sleep 72'],
				{ timeoutMs: 2000 },
			);
			expect(timedOut.problem?.code).toBe('COMMAND_TIMEOUT');
			expect(await count(project, '^[s]leep 7[12]')).toBe(0);

			const detached = await startDetached(ctx, ref, [
				'sh',
				'-c',
				'sleep 73 & sleep 74',
			]);
			expect(detached.outcome).toBe('success');
			expect(await count(project, '^[s]leep 7[34]')).toBe(2);
			// `kill` is a shell builtin: slim images have no kill binary.
			const stopped = await execCommand(ctx, ref, [
				'sh',
				'-c',
				`kill -15 -${detached.pid}`,
			]);
			expect(stopped.exitCode).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(await count(project, '^[s]leep 7[34]')).toBe(0);
		},
		5 * MINUTES,
	);
});

describe.runIf(RUN)('forward into a real container (Phase 4)', () => {
	it(
		'reaches a server bound to 127.0.0.1 inside the container, and leaves no bridges behind',
		async () => {
			const project = prepare('minimal');
			const { ctx, ref } = project;
			expect(
				(await bringUp(ctx, ref, { config: ref.configPath })).outcome,
			).toBe('success');
			const server = await startDetached(ctx, ref, [
				'perl',
				'-MIO::Socket::INET',
				'-e',
				// Escapes are doubled so Perl, not TypeScript, turns them into CR/LF:
				// Perl folds a literal CRLF in its source to LF (malformed HTTP).
				'my $s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>5173,Listen=>5,ReuseAddr=>1) or die; while(my $c=$s->accept){ while(<$c>){ last if /^\\r?\\n$/ } print $c "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok"; close $c }',
			]);
			expect(server.outcome).toBe('success');
			const containerId = await primaryId(ctx.dockerExe, ref.rootPath);

			const probe = createNetServer();
			await new Promise<void>((resolve) =>
				probe.listen(0, '127.0.0.1', resolve),
			);
			const hostPort = (probe.address() as AddressInfo).port;
			await new Promise((resolve) => probe.close(resolve));

			const forwarding = await startForwarding({
				specs: [{ hostPort, targetHost: '127.0.0.1', targetPort: 5173 }],
				openBridge: async (spec) =>
					spawn(ctx.dockerExe, [
						'exec',
						'-i',
						containerId,
						...bridgeArgv('bash', spec.targetHost, spec.targetPort),
					]),
				onEvent: () => {},
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				for (let i = 0; i < 3; i++) {
					const res = await fetch(`http://127.0.0.1:${hostPort}/`);
					expect(await res.text()).toBe('ok');
				}
			} finally {
				await forwarding.close();
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
			const left = await execCommand(ctx, ref, [
				'sh',
				'-c',
				'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "^[b]ash -c exec 3" || true',
			]);
			expect(left.stdout.trim()).toBe('0');
		},
		5 * MINUTES,
	);
});

async function primaryId(dockerExe: string, root: string): Promise<string> {
	const run = await runCommand(dockerExe, [
		'ps',
		'-q',
		'--filter',
		`label=devcontainer.local_folder=${root}`,
	]);
	if (run.outcome !== 'ran') {
		throw new Error('docker ps failed');
	}
	return run.result.stdout.trim().split('\n')[0] as string;
}

describe.runIf(RUN)('the built CLI, end to end (Phase 4)', () => {
	const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

	interface Ran {
		code: number | null;
		stdout: Buffer;
		stderr: string;
	}
	const cli = (project: Project, args: string[]): Ran => {
		const run = spawnSync(process.execPath, [CLI, ...args], {
			cwd: project.ref.rootPath,
			env: { ...project.ctx.env, BRING_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
			timeout: 4 * MINUTES,
		});
		return {
			code: run.status,
			stdout: run.stdout,
			stderr: run.stderr.toString(),
		};
	};
	const lines = (ran: Ran) =>
		ran.stdout
			.toString()
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	const countProcesses = (project: Project, pattern: string): number => {
		const ran = cli(project, [
			'exec',
			'--json',
			'--',
			'sh',
			'-c',
			`for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "${pattern}" || true`,
		]);
		expect(ran.code).toBe(0);
		const doc = JSON.parse(ran.stdout.toString()) as { stdout: string };
		expect(doc.stdout.trim()).toMatch(/^\d+$/);
		return Number(doc.stdout.trim());
	};

	it(
		'exec, --events, detach, prune preview and forward behave as documented',
		async () => {
			// `npm run test:integration` builds first; fail loudly otherwise.
			expect(
				existsSync(CLI),
				'dist/cli.js is missing — run `npm run build`',
			).toBe(true);
			const project = prepare('minimal');

			// exec never starts a workspace.
			const cold = cli(project, ['exec', '--', 'true']);
			expect(cold.code).toBe(1);
			expect(cold.stderr).toContain('is not running');
			expect(cold.stderr).toContain(' up');

			// --events: started first, completed last, nothing but JSON lines.
			const up = cli(project, ['up', '--events']);
			expect(up.code).toBe(0);
			const events = lines(up);
			expect(events[0]).toMatchObject({ schemaVersion: 1, type: 'started' });
			expect(events.at(-1)).toMatchObject({
				type: 'completed',
				result: { operation: 'up', outcome: 'success' },
			});
			expect(events.some((e) => e.type === 'output')).toBe(false);

			// --json: the command's exit code is the process exit code (DD-6).
			const failed = cli(project, [
				'exec',
				'--json',
				'--',
				'sh',
				'-c',
				'echo hi; exit 3',
			]);
			expect(failed.code).toBe(3);
			expect(JSON.parse(failed.stdout.toString())).toMatchObject({
				schemaVersion: 1,
				operation: 'exec',
				outcome: 'success',
				exitCode: 3,
				stdout: 'hi\n',
				stderr: '',
				command: ['sh', '-c', 'echo hi; exit 3'],
			});

			// Plain mode: stdout is exactly the command's bytes; the summary
			// goes to stderr.
			const binary = cli(project, [
				'exec',
				'--',
				'printf',
				'\\377\\000A\\342\\202',
			]);
			expect(binary.code).toBe(0);
			expect([...binary.stdout]).toEqual([0xff, 0x00, 0x41, 0xe2, 0x82]);
			expect(binary.stderr).toContain('✓ printf');

			// A missing command: 127 passes through, with a hint.
			const missing = cli(project, ['exec', '--', 'no-such-command']);
			expect(missing.code).toBe(127);
			expect(missing.stderr).toContain('is `no-such-command` installed');

			// Timeout: exit 124, and nothing survives — not even a process
			// that moved to its own session.
			const slow = cli(project, [
				'exec',
				'--timeout',
				'2',
				'--',
				'sh',
				'-c',
				'setsid sleep 81 & sleep 82',
			]);
			expect(slow.code).toBe(124);
			expect(slow.stderr).toContain('did not finish within 2s');
			expect(countProcesses(project, '^[s]leep 8[12]')).toBe(0);

			// Detach: returns at once; the stop command it hands back works.
			const detached = cli(project, [
				'exec',
				'--detach',
				'--json',
				'--',
				'sh',
				'-c',
				'sleep 83 & sleep 84',
			]);
			expect(detached.code).toBe(0);
			const started = JSON.parse(detached.stdout.toString()) as {
				pid: number;
				stopCommand: string;
				containerLogPath: string;
				warnings: string[];
			};
			expect(started.warnings).toEqual([]);
			expect(started.stopCommand).toBe(
				`bring . exec -- sh -c 'kill -15 -${started.pid}'`,
			);
			expect(countProcesses(project, '^[s]leep 8[34]')).toBe(2);
			// Run exactly what was handed back (minus the `bring .` prefix).
			expect(
				cli(project, ['exec', '--', 'sh', '-c', `kill -15 -${started.pid}`])
					.code,
			).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(countProcesses(project, '^[s]leep 8[34]')).toBe(0);

			// Inventory and the prune preview never change anything.
			const containers = JSON.parse(
				cli(project, ['containers', '--json']).stdout.toString(),
			) as { containers: { workspacePath: string; role: string }[] };
			expect(
				containers.containers.some(
					(c) =>
						c.workspacePath === project.ref.rootPath && c.role === 'primary',
				),
			).toBe(true);
			const preview = cli(project, ['images', 'prune', '--dry-run', '--json']);
			expect(preview.code).toBe(0);
			expect(JSON.parse(preview.stdout.toString())).toMatchObject({
				operation: 'prune',
				dryRun: true,
				outcome: 'success',
			});

			// forward: a server bound to 127.0.0.1 inside the container is
			// reachable; Ctrl+C exits 0 and leaves no bridge behind.
			expect(
				cli(project, [
					'exec',
					'--detach',
					'--',
					'perl',
					'-MIO::Socket::INET',
					'-e',
					'my $s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>5173,Listen=>5,ReuseAddr=>1) or die; while(my $c=$s->accept){ while(<$c>){ last if /^\\r?\\n$/ } print $c "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"; close $c }',
				]).code,
			).toBe(0);
			const probe = createNetServer();
			await new Promise<void>((resolve) =>
				probe.listen(0, '127.0.0.1', resolve),
			);
			const hostPort = (probe.address() as AddressInfo).port;
			await new Promise((resolve) => probe.close(resolve));
			const forward = spawn(
				process.execPath,
				[CLI, 'forward', `${hostPort}:5173`],
				{
					cwd: project.ref.rootPath,
					env: {
						...project.ctx.env,
						BRING_NO_UPDATE_CHECK: '1',
						NO_COLOR: '1',
					},
				},
			);
			let out = '';
			forward.stdout.on('data', (d: Buffer) => {
				out += d.toString();
			});
			const exited = new Promise<number | null>((resolve) =>
				forward.on('close', (code) => resolve(code)),
			);
			try {
				for (let i = 0; i < 100 && !out.includes('Ctrl+C to stop'); i++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				expect(out).toContain(`localhost:${hostPort} → 5173`);
				for (let i = 0; i < 3; i++) {
					const res = await fetch(`http://127.0.0.1:${hostPort}/`);
					expect(await res.text()).toBe('ok');
				}
			} finally {
				forward.kill('SIGINT');
			}
			expect(await exited).toBe(0);
			// Kept-alive connections end within the bridge's 3s linger.
			await new Promise((resolve) => setTimeout(resolve, 4000));
			expect(countProcesses(project, '^[b]ash -c exec 3')).toBe(0);

			// --events on an early exit still ends with `completed`.
			const refused = cli(project, ['remove', '--events']);
			expect(refused.code).toBe(2);
			expect(lines(refused).at(-1)).toMatchObject({
				type: 'completed',
				result: { outcome: 'failed', error: { code: 'USAGE_ERROR' } },
			});
		},
		8 * MINUTES,
	);
});

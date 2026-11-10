import { basename } from 'node:path';
import { readConfigurationArgv } from '../adapters/devcontainer-cli.js';
import { runCommand } from '../adapters/process-runner.js';
import type { OperationContext } from '../application/context.js';
import {
	bridgeArgv,
	bridgesForFileLimit,
	describeSpec,
	explainConnectionFailure,
	type ForwardSpec,
	HELPERS,
	type Helper,
	PROBE_SCRIPT,
	resolveSpecs,
	spawnBridge,
	startForwarding,
} from '../application/forward-ports.js';
import { listResources } from '../application/list-resources.js';
import { shellQuote } from '../core/shell-quote.js';
import type { WorkspaceRef } from '../core/types.js';
import type { makePaint } from './ansi.js';
import { EXIT } from './exit-codes.js';

type Paint = ReturnType<typeof makePaint>;

/**
 * `bring [target] forward [ports…]` (P4 §3a, DD-7): forward until Ctrl+C.
 * Foreground only — like VS Code's "forwarded while connected" — so there
 * is no daemon, pid file, or cleanup to get wrong.
 */
export async function runForwardRoute(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	ports: readonly string[] | undefined,
	paint: Paint,
): Promise<number> {
	const name = basename(workspace.rootPath);
	const target = shellQuote(workspace.input || '.');

	// Ports named on the command line are checked first: a typo is a usage
	// error whether or not the workspace is running.
	let specs: ForwardSpec[] | undefined;
	if (ports !== undefined) {
		const resolved = resolveSpecs(ports);
		if (!resolved.ok) {
			console.error(resolved.error);
			return EXIT.usage;
		}
		specs = resolved.specs;
	}

	const container = await primaryContainer(ctx, workspace);
	if (container === 'docker-failed') {
		console.error('✗ Docker could not list containers.');
		console.error('  bring doctor');
		return EXIT.operationFailed;
	}
	if (container === null) {
		console.error(`✗ ${name} is not running.`);
		console.error(`  bring ${target} up`);
		return EXIT.operationFailed;
	}

	if (specs === undefined) {
		const configured = await configuredForwardPorts(ctx, workspace);
		if (!configured.ok) {
			console.error(
				`✗ Could not read ${name}'s devcontainer configuration: ${configured.message}`,
			);
			console.error(`  Name the ports instead: bring ${target} forward 5173`);
			return EXIT.operationFailed;
		}
		if (configured.ports.length === 0) {
			console.error(
				`${name} has no forwardPorts in its devcontainer.json — name the ports instead:`,
			);
			console.error(`  bring ${target} forward 5173`);
			return EXIT.usage;
		}
		const resolved = resolveSpecs(configured.ports);
		if (!resolved.ok) {
			console.error(`forwardPorts in devcontainer.json: ${resolved.error}`);
			return EXIT.usage;
		}
		specs = resolved.specs;
	}

	const probe = await probeHelper(ctx, container);
	if (probe.outcome === 'failed') {
		console.error(
			`✗ Could not look inside ${name} for a bridge program: ${probe.message}`,
		);
		return EXIT.operationFailed;
	}
	if (probe.outcome === 'none') {
		console.error(
			`✗ ${name} has none of ${HELPERS.join(', ')} — Bring needs one of them inside the container to forward ports.`,
		);
		console.error(
			'  Add bash to the image (Alpine: apk add bash), then rebuild.',
		);
		return EXIT.dependency;
	}
	const helper = probe.helper;

	// The container id is cached; after a rebuild the next connection finds
	// the new container through the same labels `bring status` uses.
	let containerId: string | null = container;
	const env = { ...ctx.env, DOCKER_CLI_HINTS: 'false' };
	const lastWarning = new Map<number, number>();
	const warn = (spec: ForwardSpec, text: string) => {
		const now = Date.now();
		if (now - (lastWarning.get(spec.hostPort) ?? 0) < 5000) {
			return;
		}
		lastWarning.set(spec.hostPort, now);
		console.error(paint('dim', `  · localhost:${spec.hostPort}: ${text}`));
	};

	const forwarding = await startForwarding({
		specs,
		maxBridges: bridgesForFileLimit(await fileHandleLimit()),
		openBridge: async (spec) => {
			if (containerId === null) {
				const found = await primaryContainer(ctx, workspace);
				containerId = typeof found === 'string' ? found : null;
				if (containerId === null) {
					throw new Error(`${name} is not running`);
				}
			}
			const child = spawnBridge(
				ctx.dockerExe,
				[
					'exec',
					'-i',
					containerId,
					...bridgeArgv(helper, spec.targetHost, spec.targetPort),
				],
				{ env },
			);
			// Optional: a failed spawn may have no streams at all.
			child.stderr?.on('data', (chunk: Buffer) => {
				if (/no such container|is not running/i.test(chunk.toString())) {
					containerId = null;
				}
			});
			return child;
		},
		onEvent: (event) => {
			switch (event.type) {
				case 'listening':
					console.log(`${paint('green', '✓')} ${describeSpec(event.spec)}`);
					return;
				case 'listen-failed':
					console.error(
						`${paint('red', '✗')} localhost:${event.spec.hostPort} ${
							event.code === 'EADDRINUSE'
								? 'is already in use on this machine'
								: `could not be opened: ${event.message}`
						}`,
					);
					if (event.code === 'EADDRINUSE') {
						const free = event.spec.hostPort + 1;
						const remote =
							event.spec.targetHost === '127.0.0.1'
								? `${event.spec.targetPort}`
								: `${event.spec.targetHost}:${event.spec.targetPort}`;
						console.error(`  bring ${target} forward ${free}:${remote}`);
					}
					return;
				case 'connection-failed':
					warn(
						event.spec,
						explainConnectionFailure(event.message, event.spec, name),
					);
					return;
			}
		},
	});

	if (forwarding.listening.length === 0) {
		return EXIT.operationFailed;
	}
	console.log(
		paint(
			'dim',
			`Forwarding into ${name} via ${helper} (only this machine can connect) — Ctrl+C to stop.`,
		),
	);

	await new Promise<void>((resolve) => {
		const stop = () => {
			process.removeListener('SIGINT', stop);
			process.removeListener('SIGTERM', stop);
			resolve();
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
	});
	await forwarding.close();
	console.log('Stopped forwarding.');
	return EXIT.success;
}

/** This process's `ulimit -n`, when a POSIX shell can tell us. */
async function fileHandleLimit(): Promise<number | undefined> {
	const run = await runCommand('sh', ['-c', 'ulimit -n'], {});
	if (run.outcome !== 'ran' || run.result.exitCode !== 0) {
		return undefined;
	}
	const limit = Number(run.result.stdout.trim());
	return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

/** The running primary container of the workspace, by label. */
async function primaryContainer(
	ctx: OperationContext,
	workspace: WorkspaceRef,
): Promise<string | null | 'docker-failed'> {
	const listed = await listResources({
		dockerExe: ctx.dockerExe,
		env: ctx.env,
		includeImages: false,
		knownWorkspacePaths: [workspace.rootPath],
	});
	if (!listed.ok) {
		return 'docker-failed';
	}
	const mine = listed.inventory.containers.filter(
		(c) => c.workspacePath === workspace.rootPath && c.state === 'running',
	);
	return (mine.find((c) => c.role === 'primary') ?? mine[0])?.id ?? null;
}

/** `forwardPorts` after merging features/image metadata. */
async function configuredForwardPorts(
	ctx: OperationContext,
	workspace: WorkspaceRef,
): Promise<{ ok: true; ports: string[] } | { ok: false; message: string }> {
	const run = await runCommand(
		ctx.devcontainerExe,
		[
			...readConfigurationArgv(workspace.rootPath, workspace.configPath),
			'--include-merged-configuration',
		],
		{ env: ctx.env },
	);
	if (run.outcome !== 'ran') {
		return { ok: false, message: run.message };
	}
	const ports =
		run.result.exitCode === 0 ? extractForwardPorts(run.result.stdout) : null;
	if (ports === null) {
		const detail = run.result.stderr.trim().split('\n').at(-1);
		return {
			ok: false,
			message:
				detail === undefined || detail === ''
					? `the devcontainer CLI exited with code ${run.result.exitCode}`
					: detail,
		};
	}
	return { ok: true, ports };
}

/**
 * The merged `forwardPorts` from `read-configuration` output: [] when the
 * configuration has none, null when the output is not what the CLI prints.
 */
export function extractForwardPorts(stdout: string): string[] | null {
	const line = stdout
		.trim()
		.split('\n')
		.reverse()
		.find((l) => l.trim().startsWith('{'));
	if (line === undefined) {
		return null;
	}
	let parsed: {
		mergedConfiguration?: { forwardPorts?: unknown };
		configuration?: { forwardPorts?: unknown };
	};
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return null;
	}
	const ports =
		parsed.mergedConfiguration?.forwardPorts ??
		parsed.configuration?.forwardPorts;
	if (!Array.isArray(ports)) {
		return [];
	}
	return ports
		.filter((p) => typeof p === 'number' || typeof p === 'string')
		.map(String);
}

type ProbeResult =
	| { outcome: 'found'; helper: Helper }
	| { outcome: 'none' }
	| { outcome: 'failed'; message: string };

async function probeHelper(
	ctx: OperationContext,
	containerId: string,
): Promise<ProbeResult> {
	const run = await runCommand(
		ctx.dockerExe,
		['exec', containerId, 'sh', '-c', PROBE_SCRIPT],
		{ env: { ...ctx.env, DOCKER_CLI_HINTS: 'false' } },
	);
	if (run.outcome !== 'ran') {
		return { outcome: 'failed', message: run.message };
	}
	return interpretProbe(
		run.result.exitCode,
		run.result.stdout,
		run.result.stderr,
	);
}

/** Exit 1 with no output is the probe's own "none found"; anything else failed. */
export function interpretProbe(
	exitCode: number,
	stdout: string,
	stderr: string,
): ProbeResult {
	const found = stdout.trim();
	if (exitCode === 0 && (HELPERS as readonly string[]).includes(found)) {
		return { outcome: 'found', helper: found as Helper };
	}
	if (exitCode === 1 && stderr.trim() === '') {
		return { outcome: 'none' };
	}
	return {
		outcome: 'failed',
		message:
			stderr.trim().split('\n').at(-1) ||
			`docker exec exited with code ${exitCode}`,
	};
}

import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { render } from 'ink';
import { findExecutable } from '../adapters/find-executable.js';
import { bringDown } from '../application/bring-down.js';
import { bringUp } from '../application/bring-up.js';
import type { OperationContext } from '../application/context.js';
import { getSnapshot } from '../application/get-status.js';
import { openShell } from '../application/open-shell.js';
import { resolveTarget } from '../application/resolve-target.js';
import { exitCodeForProblem } from '../core/errors.js';
import type {
	OperationEvent,
	OperationResult,
} from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import type { resolveWorkspace } from '../core/workspace-resolver.js';
import { DirectOperation } from '../direct/DirectOperation.js';
import { formatResult, formatResultJson } from '../direct/format-result.js';
import { clearLogs, readLatestLog } from '../stores/log-store.js';
import { bringStateDir } from '../stores/paths.js';
import { stateFilePath } from '../stores/workspace-store.js';
import { EXIT } from './exit-codes.js';
import type { CliRoute } from './parse-argv.js';

type DirectRoute = Extract<CliRoute, { kind: 'direct' }>;

/**
 * Run one direct command end to end (spec §10): resolve, check
 * dependencies, confirm if destructive, execute, render. Returns the
 * process exit code — the only place operation outcomes become exits.
 */
export async function runDirect(route: DirectRoute): Promise<number> {
	const env = process.env;
	const cwd = process.cwd();
	const isTTY = process.stdout.isTTY === true;
	const json = route.options.json;
	const color = isTTY && env.NO_COLOR === undefined && !json;

	const { result: resolved, usedRememberedConfig } = resolveTarget(
		route.target,
		{
			cwd,
			explicitConfig: route.options.config,
			stateFile: stateFilePath(env),
		},
	);
	if (resolved.outcome !== 'resolved') {
		return reportResolutionFailure(resolved, json);
	}
	if (usedRememberedConfig !== undefined && !json) {
		console.error(
			`Using ${usedRememberedConfig} (remembered from your last --config choice; pass --config to override).`,
		);
	}
	const workspace = resolved.workspace;
	const stateDir = bringStateDir(env);

	// Logs are pure file reads — no Docker or devcontainer CLI required.
	if (route.action === 'logs') {
		return runLogs(stateDir, workspace, route.options.clear);
	}

	const devcontainerExe = findExecutable('devcontainer', env.PATH);
	const dockerExe = findExecutable('docker', env.PATH);
	if (devcontainerExe === null || dockerExe === null) {
		const missing =
			devcontainerExe === null ? 'the Dev Containers CLI' : 'Docker';
		console.error(`Bring needs ${missing}, which was not found on PATH.`);
		console.error('Run `bring doctor` for the full picture.');
		return EXIT.dependency;
	}

	const bus = createEventBus();
	const ctx: OperationContext = {
		devcontainerExe,
		dockerExe,
		stateDir,
		stateFile: stateFilePath(env),
		env,
		emit: bus.emit,
	};

	if (route.action === 'status') {
		return runStatus(ctx, workspace, json);
	}

	if (route.action === 'shell') {
		const result = await openShell(
			ctx,
			workspace,
			route.options.shellCommand ?? ['bash'],
			workspace.configPath,
		);
		if (result.outcome !== 'success') {
			console.error(formatResult(result, { color }));
			return exitFor(result);
		}
		return result.childExitCode ?? EXIT.success;
	}

	if (route.action === 'remove' && !route.options.yes) {
		const confirmed = await confirmRemoval(workspace);
		if (confirmed === 'not-interactive') {
			console.error(
				'remove deletes containers — confirm with --yes when not running interactively.',
			);
			return EXIT.usage;
		}
		if (confirmed === 'no') {
			console.log('Nothing was changed.');
			return EXIT.success;
		}
	}

	// Always hand the exact resolved config to the upstream CLI: with two
	// config locations present it would otherwise silently pick its own.
	const mutation = route.action as 'up' | 'rebuild' | 'down' | 'remove';
	const operation = (): Promise<OperationResult> => {
		switch (mutation) {
			case 'up':
				return bringUp(ctx, workspace, { config: workspace.configPath });
			case 'rebuild':
				return bringUp(ctx, workspace, {
					config: workspace.configPath,
					rebuild: true,
					noCache: route.options.noCache,
				});
			case 'down':
				return bringDown(ctx, workspace);
			case 'remove':
				return bringDown(ctx, workspace, { remove: true });
		}
	};

	// --json: one document on stdout, nothing else (spec §10.6).
	if (json) {
		const result = await operation();
		console.log(formatResultJson(result));
		return exitFor(result);
	}

	// --verbose or a pipe: plain stage lines (plus raw output when verbose),
	// never an animation (spec §10.1).
	if (route.options.verbose || !isTTY) {
		bus.on((event) => {
			if (event.type === 'stage') {
				console.log(`• ${event.message}`);
			}
			if (event.type === 'output' && route.options.verbose) {
				process.stderr.write(event.chunk);
			}
		});
		const result = await operation();
		console.log(formatResult(result, { color }));
		return exitFor(result);
	}

	// Interactive: the compact animated line, then one persistent summary.
	const instance = render(
		<DirectOperation
			subscribe={bus.on}
			initialMessage={`Checking ${workspace.rootPath}…`}
		/>,
	);
	const result = await operation();
	instance.unmount();
	await instance.waitUntilExit();
	console.log(formatResult(result, { color }));
	return exitFor(result);
}

function exitFor(result: OperationResult): number {
	switch (result.outcome) {
		case 'success':
			return EXIT.success;
		case 'cancelled':
			return EXIT.success;
		case 'interrupted':
			return EXIT.interrupted;
		case 'failed':
			return result.problem === undefined
				? EXIT.operationFailed
				: exitCodeForProblem(result.problem.code);
	}
}

function reportResolutionFailure(
	resolved: Exclude<
		ReturnType<typeof resolveWorkspace>,
		{ outcome: 'resolved' }
	>,
	json: boolean,
): number {
	if (json) {
		console.log(
			JSON.stringify(
				{
					schemaVersion: 1,
					outcome: 'failed',
					error: {
						code: resolved.problem.code,
						summary: resolved.problem.summary,
					},
				},
				null,
				2,
			),
		);
		return exitCodeForProblem(resolved.problem.code);
	}
	if (resolved.outcome === 'no-config') {
		console.error(
			`No Dev Container configuration found for ${resolved.searchedRoot}.\n`,
		);
		console.error('Expected one of:');
		console.error('  .devcontainer/devcontainer.json');
		console.error('  .devcontainer.json\n');
		console.error('Bring does not create configuration files yet.');
	} else if (resolved.outcome === 'ambiguous') {
		console.error(`${resolved.problem.summary}\n`);
		for (const config of resolved.configs) {
			console.error(`  ${config}`);
		}
		console.error(
			'\nPick one explicitly with --config <path> — after the next successful',
		);
		console.error(
			'`bring up --config …`, Bring remembers your choice for this project.',
		);
	} else {
		console.error(resolved.problem.summary);
	}
	return exitCodeForProblem(resolved.problem.code);
}

async function runStatus(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	json: boolean,
): Promise<number> {
	const result = await getSnapshot(ctx, workspace);
	if (!result.ok) {
		console.error(result.problem.summary);
		return exitCodeForProblem(result.problem.code);
	}
	const s = result.snapshot;
	if (json) {
		console.log(
			JSON.stringify(
				{
					schemaVersion: 1,
					operation: 'status',
					workspace: s.workspace.rootPath,
					name: s.name,
					status: s.status,
					configPath: s.workspace.configPath,
					containerIds: s.containerIds,
					imageNames: s.imageNames,
					forwardedPorts: s.forwardedPorts,
				},
				null,
				2,
			),
		);
		return EXIT.success;
	}
	const lines = [
		`${s.name}  ${s.status}`,
		`  config      ${relative(s.workspace.rootPath, s.workspace.configPath)}`,
	];
	if (s.containerIds.length > 0) {
		lines.push(`  containers  ${s.containerIds.join(', ')}`);
	}
	if (s.imageNames.length > 0) {
		lines.push(`  images      ${s.imageNames.join(', ')}`);
	}
	if (s.forwardedPorts.length > 0) {
		lines.push(
			`  ports       ${s.forwardedPorts
				.map((p) =>
					p.hostPort === undefined
						? `${p.containerPort}`
						: `${p.hostPort} → ${p.containerPort}`,
				)
				.join(', ')}`,
		);
	}
	console.log(lines.join('\n'));
	return EXIT.success;
}

function runLogs(
	stateDir: string,
	workspace: WorkspaceRef,
	clear: boolean,
): number {
	if (clear) {
		clearLogs(stateDir, workspace.identity);
		console.log('Logs cleared.');
		return EXIT.success;
	}
	const log = readLatestLog(stateDir, workspace.identity);
	if (log === null) {
		console.log(
			'No operation log yet — logs appear after the first `bring up`.',
		);
		return EXIT.success;
	}
	process.stdout.write(log);
	return EXIT.success;
}

async function confirmRemoval(
	workspace: WorkspaceRef,
): Promise<'yes' | 'no' | 'not-interactive'> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		return 'not-interactive';
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(
			`Remove the containers for ${workspace.rootPath}? Source files stay. [y/N] `,
		);
		return /^y(es)?$/i.test(answer.trim()) ? 'yes' : 'no';
	} finally {
		rl.close();
	}
}

function createEventBus(): {
	emit: (event: OperationEvent) => void;
	on: (listener: (event: OperationEvent) => void) => () => void;
} {
	const listeners = new Set<(event: OperationEvent) => void>();
	return {
		emit: (event) => {
			for (const listener of listeners) {
				listener(event);
			}
		},
		on: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

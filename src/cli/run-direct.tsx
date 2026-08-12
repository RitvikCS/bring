import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { render } from 'ink';
import {
	findDevcontainerExecutable,
	findExecutable,
} from '../adapters/find-executable.js';
import { bringDown } from '../application/bring-down.js';
import { bringUp } from '../application/bring-up.js';
import type { OperationContext } from '../application/context.js';
import { getSnapshot } from '../application/get-status.js';
import { openShell } from '../application/open-shell.js';
import {
	type ResolvedDotfiles,
	resolveRunDotfiles,
} from '../application/profiles.js';
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
import { enteringShellLine, leftShellLine } from '../direct/shell-banner.js';
import { clearLogs, readLatestLog } from '../stores/log-store.js';
import { bringStateDir } from '../stores/paths.js';
import {
	ensureProfileConfig,
	profileConfigPath,
} from '../stores/profile-store.js';
import { loadState, stateFilePath } from '../stores/workspace-store.js';
import { statusColor, statusLabel, statusSymbol } from '../tui/state.js';
import { type AnsiCode, makePaint } from './ansi.js';
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
	const paint = makePaint(color);
	if (usedRememberedConfig !== undefined && !json) {
		const rel = relative(resolved.workspace.rootPath, usedRememberedConfig);
		console.error(
			paint('dim', `· config ${rel} (remembered; --config overrides)`),
		);
	}
	const workspace = resolved.workspace;
	const stateDir = bringStateDir(env);

	// Logs are pure file reads — no Docker or devcontainer CLI required.
	if (route.action === 'logs') {
		return runLogs(stateDir, workspace, route.options.clear);
	}

	const devcontainerExe = findDevcontainerExecutable(env)?.path ?? null;
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
		return runStatus(ctx, workspace, json, paint);
	}

	if (route.action === 'shell') {
		const name = basename(workspace.rootPath);
		console.error(enteringShellLine(name, color));
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
		console.error(leftShellLine(name, color, result.childExitCode));
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

	// Dotfiles for this run (P3-03/P3-08): flag > workspace override >
	// default > only profile > legacy remembered URL. Interactive choice and
	// first-use confirmation happen HERE, before any operation starts.
	let dotfiles: ResolvedDotfiles | null = null;
	if (route.action === 'up' || route.action === 'rebuild') {
		const settled = await settleDirectDotfiles(route, workspace, {
			env,
			json,
			isTTY,
			paint,
		});
		if (settled.outcome === 'exit') {
			return settled.code;
		}
		dotfiles = settled.dotfiles;
	}

	// Always hand the exact resolved config to the upstream CLI: with two
	// config locations present it would otherwise silently pick its own.
	const mutation = route.action as 'up' | 'rebuild' | 'down' | 'remove';
	const operation = (): Promise<OperationResult> => {
		switch (mutation) {
			case 'up':
				return bringUp(ctx, workspace, {
					config: workspace.configPath,
					dotfiles,
				});
			case 'rebuild':
				return bringUp(ctx, workspace, {
					config: workspace.configPath,
					rebuild: true,
					noCache: route.options.noCache,
					dotfiles,
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

type SettledDotfiles =
	| { outcome: 'exit'; code: number }
	| { outcome: 'run'; dotfiles: ResolvedDotfiles | null };

/**
 * Turn the CLI flags + profile config into the dotfiles for this run.
 * Handles the two cases resolution alone cannot: several profiles with no
 * default (interactive pick or --profile required) and a profile's §15.4
 * first-use confirmation (interactive y/N, or --yes when scripted).
 */
async function settleDirectDotfiles(
	route: DirectRoute,
	workspace: WorkspaceRef,
	io: {
		env: NodeJS.ProcessEnv;
		json: boolean;
		isTTY: boolean;
		paint: ReturnType<typeof makePaint>;
	},
): Promise<SettledDotfiles> {
	const configFile = profileConfigPath(io.env);
	const stateFile = stateFilePath(io.env);
	const loaded = ensureProfileConfig(configFile, stateFile);
	if (!loaded.ok) {
		console.error(loaded.problem.summary);
		if (loaded.problem.remedy !== undefined) {
			console.error(loaded.problem.remedy);
		}
		return { outcome: 'exit', code: exitCodeForProblem(loaded.problem.code) };
	}
	const config = loaded.config;
	const state = loadState(stateFile);
	const request = {
		flagDotfiles:
			route.options.dotfiles === 'none'
				? (false as const)
				: route.options.dotfiles,
		flagProfile:
			route.options.profile === 'none'
				? (false as const)
				: route.options.profile,
		workspacePath: workspace.rootPath,
	};
	let resolution = resolveRunDotfiles(config, state, request);

	if (resolution.outcome === 'choose') {
		if (!io.isTTY || io.json) {
			console.error(
				`Several dotfiles profiles exist (${resolution.names.join(', ')}) and none is the default.`,
			);
			console.error(
				'Pass --profile <name> (or --profile none), or set a default in the TUI: bring profiles',
			);
			return { outcome: 'exit', code: EXIT.usage };
		}
		const chosen = await chooseProfileInteractively(resolution.names);
		if (chosen === null) {
			console.error(io.paint('dim', '· continuing without dotfiles'));
			return { outcome: 'run', dotfiles: null };
		}
		resolution = resolveRunDotfiles(config, state, {
			...request,
			flagProfile: chosen,
		});
	}
	if (resolution.outcome !== 'resolved') {
		if (resolution.outcome === 'failed') {
			console.error(resolution.problem.summary);
			if (resolution.problem.remedy !== undefined) {
				console.error(resolution.problem.remedy);
			}
			return {
				outcome: 'exit',
				code: exitCodeForProblem(resolution.problem.code),
			};
		}
		return { outcome: 'run', dotfiles: null };
	}

	const resolved = resolution.dotfiles;
	if (resolved === null) {
		return { outcome: 'run', dotfiles: null };
	}
	if (resolved.needsConfirmation === true && !route.options.yes) {
		if (!io.isTTY || io.json) {
			console.error(
				`First use of dotfiles profile ${resolved.profileName}: confirm it with --yes or skip it with --profile none.`,
			);
			printProfileSummary(resolved, console.error);
			return { outcome: 'exit', code: EXIT.usage };
		}
		console.error(
			`First use of dotfiles profile ${resolved.profileName} — it will run inside the container:`,
		);
		printProfileSummary(resolved, console.error);
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let answer: string;
		try {
			answer = await rl.question('Apply this profile? [y/N] ');
		} finally {
			rl.close();
		}
		if (!/^y(es)?$/i.test(answer.trim())) {
			console.error(io.paint('dim', '· continuing without dotfiles'));
			return { outcome: 'run', dotfiles: null };
		}
	}
	if (!io.json) {
		const note =
			resolved.source === 'profile'
				? `· dotfiles profile ${resolved.profileName} → ${resolved.repository} (--profile none skips once)`
				: resolved.source === 'remembered'
					? `· dotfiles ${resolved.repository} (remembered; --dotfiles none skips once)`
					: null;
		if (note !== null) {
			console.error(io.paint('dim', note));
		}
	}
	return { outcome: 'run', dotfiles: resolved };
}

function printProfileSummary(
	resolved: ResolvedDotfiles,
	write: (line: string) => void,
): void {
	write(`  repository   ${resolved.repository}`);
	write(`  install      ${resolved.installCommand ?? '(repository default)'}`);
	if (resolved.targetPath !== undefined) {
		write(`  target path  ${resolved.targetPath}`);
	}
}

async function chooseProfileInteractively(
	names: readonly string[],
): Promise<string | null> {
	console.error('Several dotfiles profiles exist and none is the default:');
	names.forEach((name, index) => {
		console.error(`  ${index + 1}) ${name}`);
	});
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		for (;;) {
			const answer = (
				await rl.question('Profile for this run (number, name, or `none`): ')
			).trim();
			if (answer === 'none' || answer === '') {
				return null;
			}
			const byNumber = names[Number(answer) - 1];
			if (byNumber !== undefined && /^\d+$/.test(answer)) {
				return byNumber;
			}
			if (names.includes(answer)) {
				return answer;
			}
			console.error(`  \`${answer}\` is not one of the profiles above.`);
		}
	} finally {
		rl.close();
	}
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
	paint: ReturnType<typeof makePaint>,
): Promise<number> {
	const result = await getSnapshot(ctx, workspace);
	if (!result.ok) {
		console.error(result.problem.summary);
		return exitCodeForProblem(result.problem.code);
	}
	const s = result.snapshot;
	const state = loadState(ctx.stateFile);
	const dotfilesRepository = state.dotfilesRepository ?? null;
	// What dotfiles WOULD apply to an `up` right now (§15.3), for display.
	const profileConfig = ensureProfileConfig(
		profileConfigPath(ctx.env),
		ctx.stateFile,
	);
	const effective = profileConfig.ok
		? resolveRunDotfiles(profileConfig.config, state, {
				workspacePath: workspace.rootPath,
			})
		: null;
	const effectiveDotfiles =
		effective?.outcome === 'resolved' ? effective.dotfiles : null;
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
					dotfilesRepository,
					dotfilesProfile: effectiveDotfiles?.profileName ?? null,
				},
				null,
				2,
			),
		);
		return EXIT.success;
	}
	const statusInk = statusColor(s.status);
	const statusText = `${statusSymbol(s.status)} ${statusLabel(s.status)}`;
	const label = (text: string) => paint('dim', text.padEnd(12));
	const lines = [
		`${paint('bold', s.name)}  ${
			statusInk === undefined
				? statusText
				: paint(statusInk as AnsiCode, statusText)
		}`,
		`  ${label('config')}${relative(s.workspace.rootPath, s.workspace.configPath)}`,
	];
	if (s.containerIds.length > 0) {
		lines.push(`  ${label('containers')}${s.containerIds.join(', ')}`);
	}
	if (s.imageNames.length > 0) {
		lines.push(`  ${label('images')}${s.imageNames.join(', ')}`);
	}
	if (s.forwardedPorts.length > 0) {
		lines.push(
			`  ${label('ports')}${s.forwardedPorts
				.map((p) =>
					p.hostPort === undefined
						? `${p.containerPort}`
						: `${p.hostPort} → ${p.containerPort}`,
				)
				.join(', ')}`,
		);
	}
	if (effectiveDotfiles?.source === 'profile') {
		lines.push(
			`  ${label('dotfiles')}${effectiveDotfiles.profileName} ${paint(
				'dim',
				`(profile → ${effectiveDotfiles.repository})`,
			)}`,
		);
	} else if (effective?.outcome === 'choose') {
		lines.push(
			`  ${label('dotfiles')}${paint(
				'dim',
				`several profiles, no default — up will ask (${effective.names.join(', ')})`,
			)}`,
		);
	} else if (dotfilesRepository !== null) {
		lines.push(
			`  ${label('dotfiles')}${dotfilesRepository} ${paint('dim', '(user default)')}`,
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

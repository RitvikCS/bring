// Argv routing (spec §6). Deterministic and total: every input maps to
// exactly one route, unknown flags are rejected before anything runs
// (rule 8), and tokens after `--` are never reinterpreted (rule 7).

export type DirectAction =
	| 'up'
	| 'down'
	| 'rebuild'
	| 'shell'
	| 'exec'
	| 'forward'
	| 'logs'
	| 'status'
	| 'remove';

export interface DirectOptions {
	json: boolean;
	verbose: boolean;
	yes: boolean;
	noCache: boolean;
	clear: boolean;
	config?: string;
	/** Dotfiles repo URL, or the literal `none` to skip once (A6). */
	dotfiles?: string;
	/** Dotfiles profile name, or the literal `none` to skip once (P3-10). */
	profile?: string;
	/** Tokens after `--`, only meaningful for shell and exec. */
	shellCommand?: string[];
	/** exec: stop the command after this many seconds. */
	timeoutSeconds?: number;
	/** exec: start in the background and return at once. */
	detach: boolean;
	/** up/rebuild/down/remove: one JSON line per OperationEvent (NDJSON). */
	events: boolean;
	/** images prune: list what would be removed, change nothing. */
	dryRun: boolean;
	/** forward: explicit port specs (5173, 8080:3000, db:5432). */
	ports?: string[];
}

export type CliRoute =
	| { kind: 'version' }
	| { kind: 'help' }
	| { kind: 'tui' }
	| { kind: 'doctor'; json: boolean }
	| { kind: 'ls'; json: boolean }
	| { kind: 'forget'; target: string; json: boolean }
	| { kind: 'section'; section: string }
	| { kind: 'inventory'; section: 'containers' | 'images' }
	| { kind: 'prune'; json: boolean; yes: boolean; dryRun: boolean }
	| {
			kind: 'direct';
			target: string;
			action: DirectAction;
			options: DirectOptions;
	  }
	| { kind: 'usage-error'; message: string }
	| { kind: 'unknown-option'; option: string }
	| { kind: 'not-implemented'; input: string };

const ACTIONS = new Set<string>([
	'up',
	'down',
	'stop', // alias for down (spec §6.2)
	'rebuild',
	'shell',
	'exec',
	'forward',
	'logs',
	'status',
	'remove',
]);
const SECTIONS = new Set(['workspaces', 'containers', 'images', 'profiles']);
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v']);

export function parseArgv(argv: readonly string[]): CliRoute {
	// Rule 7: nothing after `--` is parsed as Bring syntax.
	const separator = argv.indexOf('--');
	const head = separator === -1 ? [...argv] : argv.slice(0, separator);
	const shellCommand =
		separator === -1 ? undefined : [...argv.slice(separator + 1)];

	if (head.some((token) => HELP_FLAGS.has(token))) {
		return { kind: 'help' };
	}
	if (head.some((token) => VERSION_FLAGS.has(token))) {
		return { kind: 'version' };
	}

	const options: DirectOptions = {
		json: false,
		verbose: false,
		yes: false,
		noCache: false,
		clear: false,
		detach: false,
		events: false,
		dryRun: false,
	};
	if (shellCommand !== undefined) {
		options.shellCommand = shellCommand;
	}
	const positionals: string[] = [];

	for (let i = 0; i < head.length; i++) {
		const token = head[i] as string;
		if (!token.startsWith('-')) {
			positionals.push(token);
			continue;
		}
		switch (token) {
			case '--json':
				options.json = true;
				break;
			case '--verbose':
				options.verbose = true;
				break;
			case '--yes':
			case '-y':
				options.yes = true;
				break;
			case '--no-cache':
				options.noCache = true;
				break;
			case '--clear':
				options.clear = true;
				break;
			case '--no-color':
				break; // honored by renderers via NO_COLOR handling in cli.tsx
			case '--detach':
				options.detach = true;
				break;
			case '--events':
				options.events = true;
				break;
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--timeout': {
				const value = head[i + 1];
				const seconds = value === undefined ? Number.NaN : Number(value);
				if (!Number.isInteger(seconds) || seconds <= 0) {
					return {
						kind: 'usage-error',
						message:
							'--timeout needs a whole number of seconds, e.g. --timeout 120',
					};
				}
				options.timeoutSeconds = seconds;
				i++;
				break;
			}
			case '--dotfiles': {
				const value = head[i + 1];
				if (value === undefined || value.startsWith('-')) {
					return {
						kind: 'usage-error',
						message:
							'--dotfiles needs a repository URL (or `none` to skip once), e.g. --dotfiles https://github.com/you/dotfiles',
					};
				}
				options.dotfiles = value;
				i++;
				break;
			}
			case '--profile': {
				const value = head[i + 1];
				if (value === undefined || value.startsWith('-')) {
					return {
						kind: 'usage-error',
						message:
							'--profile needs a profile name (or `none` to skip once), e.g. --profile personal',
					};
				}
				options.profile = value;
				i++;
				break;
			}
			case '--config': {
				const value = head[i + 1];
				if (value === undefined || value.startsWith('-')) {
					return {
						kind: 'usage-error',
						message:
							'--config needs a path, e.g. --config .devcontainer/api/devcontainer.json',
					};
				}
				options.config = value;
				i++;
				break;
			}
			default:
				return { kind: 'unknown-option', option: token };
		}
	}

	if (positionals.length === 0) {
		if (shellCommand !== undefined) {
			return {
				kind: 'usage-error',
				message: TOKENS_AFTER_SEPARATOR,
			};
		}
		return { kind: 'tui' };
	}

	const first = positionals[0] as string;

	if (first === 'doctor') {
		return positionals.length === 1
			? { kind: 'doctor', json: options.json }
			: usage(
					`\`bring doctor\` takes no arguments (got \`${positionals[1]}\`).`,
				);
	}
	if (first === 'ls') {
		return positionals.length === 1
			? { kind: 'ls', json: options.json }
			: usage(`\`bring ls\` takes no arguments (got \`${positionals[1]}\`).`);
	}
	if (first === 'forget') {
		if (positionals.length !== 2) {
			return usage(
				'`bring forget` needs exactly one workspace (a name from `bring ls` or a path).',
			);
		}
		return {
			kind: 'forget',
			target: positionals[1] as string,
			json: options.json,
		};
	}
	if (first === 'images' && positionals[1] === 'prune') {
		if (positionals.length !== 2) {
			return usage(`Unexpected argument \`${positionals[2]}\`.`);
		}
		if (options.dryRun && options.yes) {
			return usage(
				'--dry-run and --yes conflict — preview or remove, not both.',
			);
		}
		return {
			kind: 'prune',
			json: options.json,
			yes: options.yes,
			dryRun: options.dryRun,
		};
	}
	if (SECTIONS.has(first)) {
		if (positionals.length !== 1) {
			return usage(
				first === 'images'
					? `\`bring images\` takes no arguments except \`prune\`.`
					: `\`bring ${first}\` takes no arguments.`,
			);
		}
		// With --json the inventory sections answer directly instead of
		// opening the TUI; without it nothing changes for humans.
		if (options.json && (first === 'containers' || first === 'images')) {
			return { kind: 'inventory', section: first };
		}
		return { kind: 'section', section: first };
	}
	if (options.dryRun) {
		return usage('--dry-run only applies to `bring images prune`.');
	}

	// Rule 4: a leading action implies the `.` target.
	const leadingAction = ACTIONS.has(first);
	const target = leadingAction ? '.' : first;
	const actionToken = leadingAction ? first : positionals[1];
	const rest = positionals.slice(leadingAction ? 1 : 2);
	const extra = rest[0];

	if (actionToken === undefined) {
		return usage(
			`Expected an action after \`${target}\` — one of: up, down, rebuild, shell, exec, forward, logs, status, remove.`,
		);
	}
	if (!ACTIONS.has(actionToken)) {
		return usage(
			`\`${actionToken}\` is not an action. Try: up, down, rebuild, shell, exec, forward, logs, status, remove.`,
		);
	}
	if (actionToken === 'forward') {
		// Ports follow the action: `bring forward 5173 8080:3000`.
		if (rest.length > 0) {
			options.ports = rest as string[];
		}
		if (options.json) {
			return usage('--json does not apply to forward — it runs until Ctrl+C.');
		}
	} else if (extra !== undefined) {
		return usage(`Unexpected argument \`${extra}\`.`);
	}

	const action = (
		actionToken === 'stop' ? 'down' : actionToken
	) as DirectAction;

	if (
		options.shellCommand !== undefined &&
		action !== 'shell' &&
		action !== 'exec'
	) {
		return usage(TOKENS_AFTER_SEPARATOR);
	}
	if (options.events) {
		if (options.json) {
			return usage(
				'--events and --json conflict — --events already ends with the result as its last line.',
			);
		}
		if (!EVENT_ACTIONS.has(action)) {
			return usage('--events only applies to up, rebuild, down, and remove.');
		}
	}
	if (action === 'exec') {
		const problem = validateExec(options);
		if (problem !== undefined) {
			return usage(problem);
		}
	} else if (options.timeoutSeconds !== undefined) {
		return usage('--timeout only applies to exec.');
	} else if (options.detach) {
		return usage('--detach only applies to exec.');
	}
	if (options.noCache && action !== 'rebuild') {
		return usage('--no-cache only applies to rebuild.');
	}
	if (options.clear && action !== 'logs') {
		return usage('--clear only applies to logs.');
	}
	if (
		options.dotfiles !== undefined &&
		action !== 'up' &&
		action !== 'rebuild'
	) {
		return usage('--dotfiles only applies to up and rebuild.');
	}
	if (
		options.profile !== undefined &&
		action !== 'up' &&
		action !== 'rebuild'
	) {
		return usage('--profile only applies to up and rebuild.');
	}
	if (options.profile !== undefined && options.dotfiles !== undefined) {
		return usage(
			'--profile and --dotfiles conflict — pick one way to choose dotfiles for this run.',
		);
	}

	return { kind: 'direct', target, action, options };
}

const EVENT_ACTIONS = new Set<DirectAction>([
	'up',
	'rebuild',
	'down',
	'remove',
]);

const TOKENS_AFTER_SEPARATOR =
	'Tokens after `--` only apply to shell and exec, e.g. `bring . exec -- npm test`.';

function validateExec(options: DirectOptions): string | undefined {
	if (options.shellCommand === undefined || options.shellCommand.length === 0) {
		return '`bring exec` needs a command after `--`, e.g. `bring . exec -- npm test`.';
	}
	if (options.detach && options.timeoutSeconds !== undefined) {
		return '--timeout and --detach conflict — a detached command keeps running by design.';
	}
	const notForExec: [boolean, string][] = [
		[options.verbose, '--verbose'],
		[options.yes, '--yes'],
	];
	for (const [set, flag] of notForExec) {
		if (set) {
			return `${flag} does not apply to exec.`;
		}
	}
	return undefined;
}

function usage(message: string): CliRoute {
	return { kind: 'usage-error', message };
}

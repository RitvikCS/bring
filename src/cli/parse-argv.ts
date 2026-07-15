// Argv routing (spec §6). Deterministic and total: every input maps to
// exactly one route, unknown flags are rejected before anything runs
// (rule 8), and tokens after `--` are never reinterpreted (rule 7).

export type DirectAction =
	| 'up'
	| 'down'
	| 'rebuild'
	| 'shell'
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
	/** Tokens after `--`, only meaningful for shell. */
	shellCommand?: string[];
}

export type CliRoute =
	| { kind: 'version' }
	| { kind: 'help' }
	| { kind: 'tui' }
	| { kind: 'doctor'; json: boolean }
	| { kind: 'ls'; json: boolean }
	| { kind: 'section'; section: string }
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
				message:
					'Tokens after `--` only apply to shell, e.g. `bring . shell -- zsh`.',
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
	if (SECTIONS.has(first)) {
		return positionals.length === 1
			? { kind: 'section', section: first }
			: usage(`\`bring ${first}\` takes no arguments.`);
	}

	// Rule 4: a leading action implies the `.` target.
	const [target, actionToken, extra] = ACTIONS.has(first)
		? ['.', first, positionals[1]]
		: [first, positionals[1], positionals[2]];

	if (actionToken === undefined) {
		return usage(
			`Expected an action after \`${target}\` — one of: up, down, rebuild, shell, logs, status, remove.`,
		);
	}
	if (!ACTIONS.has(actionToken)) {
		return usage(
			`\`${actionToken}\` is not an action. Try: up, down, rebuild, shell, logs, status, remove.`,
		);
	}
	if (extra !== undefined) {
		return usage(`Unexpected argument \`${extra}\`.`);
	}

	const action = (
		actionToken === 'stop' ? 'down' : actionToken
	) as DirectAction;

	if (options.shellCommand !== undefined && action !== 'shell') {
		return usage(
			'Tokens after `--` only apply to shell, e.g. `bring . shell -- zsh`.',
		);
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

	return { kind: 'direct', target, action, options };
}

function usage(message: string): CliRoute {
	return { kind: 'usage-error', message };
}

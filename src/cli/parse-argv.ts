// Argv routing: version, help, doctor, and the no-argument entry. The full
// target/action grammar (spec §6) arrives later in Phase 1; until then any
// other input is reported as not implemented rather than guessed at.

export type CliRoute =
	| { kind: 'version' }
	| { kind: 'help' }
	| { kind: 'tui' }
	| { kind: 'doctor'; json: boolean }
	| { kind: 'usage-error'; message: string }
	| { kind: 'unknown-option'; option: string }
	| { kind: 'not-implemented'; input: string };

const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v']);

/**
 * Route the argv tokens that follow `node cli.js`.
 *
 * Help wins over version when both are present. Unknown flags are rejected
 * before anything else runs (spec §6.5 rule 8).
 */
export function parseArgv(argv: readonly string[]): CliRoute {
	if (argv.some((token) => HELP_FLAGS.has(token))) {
		return { kind: 'help' };
	}
	if (argv.some((token) => VERSION_FLAGS.has(token))) {
		return { kind: 'version' };
	}

	if (argv[0] === 'doctor') {
		const rest = argv.slice(1);
		const leftover = rest.find((token) => token !== '--json');
		if (leftover !== undefined) {
			return leftover.startsWith('-')
				? { kind: 'unknown-option', option: leftover }
				: {
						kind: 'usage-error',
						message: `\`bring doctor\` takes no arguments (got \`${leftover}\`).`,
					};
		}
		return { kind: 'doctor', json: rest.includes('--json') };
	}

	const unknownOption = argv.find((token) => token.startsWith('-'));
	if (unknownOption !== undefined) {
		return { kind: 'unknown-option', option: unknownOption };
	}

	if (argv.length === 0) {
		return { kind: 'tui' };
	}

	return { kind: 'not-implemented', input: argv.join(' ') };
}

import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/parse-argv.js';

describe('parseArgv', () => {
	it.each([
		[[], { kind: 'tui' }],
		[['--version'], { kind: 'version' }],
		[['-v'], { kind: 'version' }],
		[['--help'], { kind: 'help' }],
		[['-h'], { kind: 'help' }],
		// Help wins when both are present.
		[['--version', '--help'], { kind: 'help' }],
		[['--wat'], { kind: 'unknown-option', option: '--wat' }],
		[['-x'], { kind: 'unknown-option', option: '-x' }],
		// Unknown flags are rejected even next to future-valid tokens.
		[['up', '--force'], { kind: 'unknown-option', option: '--force' }],
		[['up'], { kind: 'not-implemented', input: 'up' }],
		[['this', 'up'], { kind: 'not-implemented', input: 'this up' }],
		[['.', 'down'], { kind: 'not-implemented', input: '. down' }],
	] as const)('routes %j to %j', (argv, expected) => {
		expect(parseArgv(argv)).toEqual(expected);
	});
});

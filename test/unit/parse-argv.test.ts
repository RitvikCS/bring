import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/parse-argv.js';

const DEFAULTS = {
	json: false,
	verbose: false,
	yes: false,
	noCache: false,
	clear: false,
};

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
		// Unknown flags are rejected even next to valid tokens (rule 8).
		[['up', '--force'], { kind: 'unknown-option', option: '--force' }],
		[['doctor'], { kind: 'doctor', json: false }],
		[['doctor', '--json'], { kind: 'doctor', json: true }],
		[['doctor', '--help'], { kind: 'help' }],
		[['ls'], { kind: 'ls', json: false }],
		[['ls', '--json'], { kind: 'ls', json: true }],
		[['workspaces'], { kind: 'section', section: 'workspaces' }],
		[['images'], { kind: 'section', section: 'images' }],
	] as const)('routes %j to %j', (argv, expected) => {
		expect(parseArgv(argv)).toEqual(expected);
	});

	it.each([
		// Rule 4: leading action implies the `.` target.
		[['up'], '.', 'up', {}],
		[['down'], '.', 'down', {}],
		// `this` and paths are targets (rules 5–6 resolve later).
		[['this', 'up'], 'this', 'up', {}],
		[['.', 'down'], '.', 'down', {}],
		[['../api', 'status'], '../api', 'status', {}],
		// stop is an alias for down.
		[['stop'], '.', 'down', {}],
		[['.', 'stop'], '.', 'down', {}],
		// Options attach to the action.
		[['rebuild', '--no-cache'], '.', 'rebuild', { noCache: true }],
		[['remove', '--yes'], '.', 'remove', { yes: true }],
		[['remove', '-y'], '.', 'remove', { yes: true }],
		[['up', '--verbose'], '.', 'up', { verbose: true }],
		[['status', '--json'], '.', 'status', { json: true }],
		[['logs', '--clear'], '.', 'logs', { clear: true }],
		[
			['up', '--config', 'x/devcontainer.json'],
			'.',
			'up',
			{ config: 'x/devcontainer.json' },
		],
	] as const)('parses %j as a direct command', (argv, target, action, opts) => {
		expect(parseArgv(argv)).toEqual({
			kind: 'direct',
			target,
			action,
			options: { ...DEFAULTS, ...opts },
		});
	});

	it('passes tokens after -- to shell untouched (rule 7)', () => {
		expect(
			parseArgv(['shell', '--', 'zsh', '-c', 'echo hi; rm -rf /']),
		).toEqual({
			kind: 'direct',
			target: '.',
			action: 'shell',
			options: {
				...DEFAULTS,
				shellCommand: ['zsh', '-c', 'echo hi; rm -rf /'],
			},
		});
	});

	it.each([
		[['.'], /expected an action/i],
		[['../api'], /expected an action/i],
		[['.', 'dance'], /not an action/i],
		[['.', 'up', 'extra'], /unexpected argument/i],
		[['doctor', 'extra'], /takes no arguments/i],
		[['--config'], /needs a path/i],
		[['up', '--no-cache'], /only applies to rebuild/i],
		[['up', '--clear'], /only applies to logs/i],
		[['up', '--', 'zsh'], /only apply to shell/i],
		[['--', 'zsh'], /only apply to shell/i],
	] as const)('rejects %j with a usage error', (argv, pattern) => {
		const route = parseArgv(argv);
		expect(route.kind).toBe('usage-error');
		if (route.kind === 'usage-error') {
			expect(route.message).toMatch(pattern);
		}
	});
});

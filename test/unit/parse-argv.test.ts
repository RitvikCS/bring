import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/parse-argv.js';

const DEFAULTS = {
	json: false,
	verbose: false,
	yes: false,
	noCache: false,
	clear: false,
	detach: false,
	events: false,
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
		[['forget', 'api'], { kind: 'forget', target: 'api' }],
		[['forget', '../api'], { kind: 'forget', target: '../api' }],
		[['workspaces'], { kind: 'section', section: 'workspaces' }],
		[['containers'], { kind: 'section', section: 'containers' }],
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
		// Dotfiles (A6): a URL or the literal `none`, on up and rebuild.
		[
			['up', '--dotfiles', 'https://github.com/u/dotfiles'],
			'.',
			'up',
			{ dotfiles: 'https://github.com/u/dotfiles' },
		],
		[['rebuild', '--dotfiles', 'none'], '.', 'rebuild', { dotfiles: 'none' }],
		// Profiles (P3-10): a name or the literal `none`, on up and rebuild.
		[['up', '--profile', 'personal'], '.', 'up', { profile: 'personal' }],
		[['rebuild', '--profile', 'none'], '.', 'rebuild', { profile: 'none' }],
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
		[['up', '--dotfiles'], /needs a repository url/i],
		[['status', '--dotfiles', 'x'], /only applies to up and rebuild/i],
		[['up', '--profile'], /needs a profile name/i],
		[['shell', '--profile', 'x'], /only applies to up and rebuild/i],
		[['up', '--profile', 'a', '--dotfiles', 'b'], /conflict/i],
		[['forget'], /needs exactly one workspace/i],
		[['forget', 'a', 'b'], /needs exactly one workspace/i],
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

describe('parseArgv — exec (Phase 4)', () => {
	it('routes exec with its command after `--`', () => {
		expect(parseArgv(['exec', '--json', '--', 'npm', 'test'])).toEqual({
			kind: 'direct',
			target: '.',
			action: 'exec',
			options: { ...DEFAULTS, json: true, shellCommand: ['npm', 'test'] },
		});
	});

	it('accepts a target, --timeout and --config before `--`', () => {
		expect(
			parseArgv(['api', 'exec', '--timeout', '30', '--', 'sh', '-c', 'x']),
		).toMatchObject({
			kind: 'direct',
			target: 'api',
			action: 'exec',
			options: { timeoutSeconds: 30, shellCommand: ['sh', '-c', 'x'] },
		});
	});

	it('never reads flags after `--` as Bring flags', () => {
		expect(parseArgv(['exec', '--', 'ls', '--json'])).toMatchObject({
			options: { json: false, shellCommand: ['ls', '--json'] },
		});
	});

	it.each([
		[['exec']],
		[['exec', '--json']],
		[['exec', '--']],
	])('requires a command after `--` (%j)', (argv) => {
		expect(parseArgv(argv)).toMatchObject({
			kind: 'usage-error',
			message: expect.stringContaining('needs a command'),
		});
	});

	it.each([
		[['exec', '--timeout', '0', '--', 'x'], 'whole number'],
		[['exec', '--timeout', 'soon', '--', 'x'], 'whole number'],
		[['exec', '--timeout'], 'whole number'],
		[['exec', '--timeout', '1.5', '--', 'x'], 'whole number'],
		[['exec', '--detach', '--timeout', '5', '--', 'x'], 'conflict'],
		[['exec', '--verbose', '--', 'x'], 'does not apply to exec'],
		[['exec', '--yes', '--', 'x'], 'does not apply to exec'],
		[['up', '--timeout', '5'], 'only applies to exec'],
		[['up', '--detach'], 'only applies to exec'],
		[['up', '--', 'x'], 'shell and exec'],
	])('rejects %j', (argv, fragment) => {
		expect(parseArgv(argv)).toMatchObject({
			kind: 'usage-error',
			message: expect.stringContaining(fragment),
		});
	});

	it('allows --detach with --json', () => {
		expect(
			parseArgv(['exec', '--detach', '--json', '--', 'npm', 'run', 'dev']),
		).toMatchObject({
			action: 'exec',
			options: { detach: true, json: true },
		});
	});
});

describe('parseArgv — --events (Phase 4)', () => {
	it.each([
		['up'],
		['rebuild'],
		['down'],
		['remove'],
	])('accepts %s', (action) => {
		expect(parseArgv([action, '--events', '--verbose'])).toMatchObject({
			kind: 'direct',
			options: { events: true, verbose: true },
		});
	});

	it.each([
		[['up', '--events', '--json'], 'conflict'],
		[['status', '--events'], 'only applies to up'],
		[['exec', '--events', '--', 'x'], 'only applies to up'],
	])('rejects %j', (argv, fragment) => {
		expect(parseArgv(argv)).toMatchObject({
			kind: 'usage-error',
			message: expect.stringContaining(fragment),
		});
	});
});

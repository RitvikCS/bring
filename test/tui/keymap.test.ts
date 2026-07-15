import { describe, expect, it } from 'vitest';
import {
	type KeyContext,
	type KeyInfo,
	keyToCommand,
} from '../../src/tui/keymap.js';

// P1-35: every §11.3 binding as a pure function call — no rendering, no
// stdin simulation (unreliable on Ink 7), just input → command.

const READY: KeyContext = {
	phase: 'ready',
	modal: null,
	logViewOpen: false,
	operationRunning: false,
	operationSettled: false,
};

const key = (partial: KeyInfo = {}): KeyInfo => partial;

describe('keymap: ready screen', () => {
	it('maps j/k and arrows to selection movement', () => {
		expect(keyToCommand('j', key(), READY)).toEqual({
			kind: 'move-selection',
			delta: 1,
		});
		expect(keyToCommand('k', key(), READY)).toEqual({
			kind: 'move-selection',
			delta: -1,
		});
		expect(keyToCommand('', key({ downArrow: true }), READY)).toEqual({
			kind: 'move-selection',
			delta: 1,
		});
		expect(keyToCommand('', key({ upArrow: true }), READY)).toEqual({
			kind: 'move-selection',
			delta: -1,
		});
	});

	it('maps h/l and side arrows to section movement', () => {
		expect(keyToCommand('h', key(), READY)).toEqual({
			kind: 'move-section',
			delta: -1,
		});
		expect(keyToCommand('l', key(), READY)).toEqual({
			kind: 'move-section',
			delta: 1,
		});
		expect(keyToCommand('', key({ leftArrow: true }), READY)).toEqual({
			kind: 'move-section',
			delta: -1,
		});
		expect(keyToCommand('', key({ rightArrow: true }), READY)).toEqual({
			kind: 'move-section',
			delta: 1,
		});
	});

	it('maps ctrl+h/ctrl+l to pane focus, beating section movement', () => {
		expect(keyToCommand('h', key({ ctrl: true }), READY)).toEqual({
			kind: 'focus-pane',
			pane: 'list',
		});
		expect(keyToCommand('l', key({ ctrl: true }), READY)).toEqual({
			kind: 'focus-pane',
			pane: 'detail',
		});
	});

	it('maps the §11.3 action keys', () => {
		expect(keyToCommand('u', key(), READY)).toEqual({ kind: 'workspace-up' });
		expect(keyToCommand('d', key(), READY)).toEqual({ kind: 'workspace-down' });
		expect(keyToCommand('r', key(), READY)).toEqual({
			kind: 'rebuild-or-refresh',
		});
		expect(keyToCommand('e', key(), READY)).toEqual({ kind: 'open-shell' });
		expect(keyToCommand('L', key(), READY)).toEqual({ kind: 'open-logs' });
		expect(keyToCommand('x', key(), READY)).toEqual({ kind: 'request-remove' });
		expect(keyToCommand('?', key(), READY)).toEqual({ kind: 'open-help' });
		expect(keyToCommand('q', key(), READY)).toEqual({ kind: 'quit' });
		expect(keyToCommand('', key({ return: true }), READY)).toEqual({
			kind: 'primary',
		});
		expect(keyToCommand('', key({ escape: true }), READY)).toEqual({
			kind: 'back',
		});
	});

	it('ignores unbound keys', () => {
		expect(keyToCommand('z', key(), READY)).toBeNull();
		expect(keyToCommand('1', key(), READY)).toBeNull();
	});
});

describe('keymap: while an operation runs', () => {
	const running: KeyContext = { ...READY, operationRunning: true };

	it('refuses mutations and shell but keeps navigation and logs', () => {
		expect(keyToCommand('u', key(), running)).toBeNull();
		expect(keyToCommand('d', key(), running)).toBeNull();
		expect(keyToCommand('r', key(), running)).toBeNull();
		expect(keyToCommand('e', key(), running)).toBeNull();
		expect(keyToCommand('x', key(), running)).toBeNull();
		expect(keyToCommand('', key({ return: true }), running)).toBeNull();
		expect(keyToCommand('j', key(), running)).toEqual({
			kind: 'move-selection',
			delta: 1,
		});
		expect(keyToCommand('L', key(), running)).toEqual({ kind: 'open-logs' });
	});

	it('surfaces q so the app can explain the refusal', () => {
		expect(keyToCommand('q', key(), running)).toEqual({ kind: 'quit' });
	});
});

describe('keymap: settled operation pane', () => {
	const settled: KeyContext = { ...READY, operationSettled: true };

	it('dismisses on Enter/Esc/q and still reaches logs and help', () => {
		expect(keyToCommand('', key({ return: true }), settled)).toEqual({
			kind: 'dismiss-operation',
		});
		expect(keyToCommand('', key({ escape: true }), settled)).toEqual({
			kind: 'dismiss-operation',
		});
		expect(keyToCommand('q', key(), settled)).toEqual({
			kind: 'dismiss-operation',
		});
		expect(keyToCommand('L', key(), settled)).toEqual({ kind: 'open-logs' });
		expect(keyToCommand('?', key(), settled)).toEqual({ kind: 'open-help' });
		expect(keyToCommand('u', key(), settled)).toBeNull();
	});
});

describe('keymap: modals', () => {
	it('help closes on Esc, q, or ? — and swallows everything else', () => {
		const help: KeyContext = { ...READY, modal: 'help' };
		expect(keyToCommand('', key({ escape: true }), help)).toEqual({
			kind: 'close-modal',
		});
		expect(keyToCommand('q', key(), help)).toEqual({ kind: 'close-modal' });
		expect(keyToCommand('?', key(), help)).toEqual({ kind: 'close-modal' });
		expect(keyToCommand('x', key(), help)).toBeNull();
		expect(keyToCommand('u', key(), help)).toBeNull();
	});

	it('confirm-remove only removes via Enter — x can never delete (§11.3)', () => {
		const confirm: KeyContext = { ...READY, modal: 'confirm-remove' };
		expect(keyToCommand('x', key(), confirm)).toBeNull();
		expect(keyToCommand('y', key(), confirm)).toBeNull();
		expect(keyToCommand('', key({ return: true }), confirm)).toEqual({
			kind: 'confirm-modal',
		});
		expect(keyToCommand('', key({ escape: true }), confirm)).toEqual({
			kind: 'close-modal',
		});
		expect(keyToCommand('n', key(), confirm)).toEqual({ kind: 'close-modal' });
	});
});

describe('keymap: log view', () => {
	const logs: KeyContext = { ...READY, logViewOpen: true };

	it('scrolls with j/k, pages, jumps with g/G, leaves with Esc/q', () => {
		expect(keyToCommand('j', key(), logs)).toEqual({
			kind: 'scroll-logs',
			delta: 1,
		});
		expect(keyToCommand('k', key(), logs)).toEqual({
			kind: 'scroll-logs',
			delta: -1,
		});
		expect(keyToCommand('', key({ pageDown: true }), logs)).toEqual({
			kind: 'scroll-logs',
			delta: 10,
		});
		expect(keyToCommand('G', key(), logs)).toEqual({
			kind: 'scroll-logs',
			delta: Number.MAX_SAFE_INTEGER,
		});
		expect(keyToCommand('g', key(), logs)).toEqual({
			kind: 'scroll-logs',
			delta: -Number.MAX_SAFE_INTEGER,
		});
		expect(keyToCommand('', key({ escape: true }), logs)).toEqual({
			kind: 'back',
		});
		expect(keyToCommand('q', key(), logs)).toEqual({ kind: 'back' });
		expect(keyToCommand('x', key(), logs)).toBeNull();
	});
});

describe('keymap: other phases', () => {
	it('doctor-blocked only retries or quits', () => {
		const blocked: KeyContext = { ...READY, phase: 'doctor-blocked' };
		expect(keyToCommand('r', key(), blocked)).toEqual({
			kind: 'retry-doctor',
		});
		expect(keyToCommand('q', key(), blocked)).toEqual({ kind: 'quit' });
		expect(keyToCommand('u', key(), blocked)).toBeNull();
		expect(keyToCommand('j', key(), blocked)).toBeNull();
	});

	it('loading only quits', () => {
		const loading: KeyContext = { ...READY, phase: 'loading' };
		expect(keyToCommand('q', key(), loading)).toEqual({ kind: 'quit' });
		expect(keyToCommand('j', key(), loading)).toBeNull();
	});
});

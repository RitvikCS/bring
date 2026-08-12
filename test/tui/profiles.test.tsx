import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AppView } from '../../src/tui/App.js';
import {
	type KeyContext,
	type KeyInfo,
	keyToCommand,
} from '../../src/tui/keymap.js';
import {
	effectiveProfileName,
	INITIAL_STATE,
	orderedProfileNames,
	reduce,
	resolveTuiDotfiles,
	type TuiAction,
	type TuiState,
	validateProfileForm,
} from '../../src/tui/state.js';
import { emptyProfilesData, makeWorkspace } from '../helpers/tui-fixtures.js';

// Phase 3 TUI behavior: pure reducer + keymap coverage for the Profiles
// pane, the create/edit form, and profile-aware up/rebuild resolution.

const TWO_PROFILES = emptyProfilesData({
	available: {
		personal: {
			repository: 'https://github.com/u/dotfiles',
			installCommand: './install.sh',
		},
		minimal: { repository: 'https://github.com/u/min' },
	},
});

function loaded(
	profiles = TWO_PROFILES,
	workspaces = [makeWorkspace('api', 'stopped')],
): TuiState {
	let state = reduce(INITIAL_STATE, { type: 'loaded', workspaces, profiles });
	state = reduce(state, { type: 'set-section', section: 'profiles' });
	return state;
}

function apply(state: TuiState, actions: TuiAction[]): TuiState {
	return actions.reduce(reduce, state);
}

const key = (partial: Partial<KeyInfo> = {}): KeyInfo => partial;

function context(state: TuiState): KeyContext {
	return {
		phase: 'ready',
		section: state.section,
		modal: state.modal?.kind ?? null,
		logViewOpen: false,
		operationRunning: false,
		operationSettled: false,
		filtering: false,
		filterActive: false,
		detailOpen: state.detailOpen,
		profileFormOpen: state.profileForm !== null,
	};
}

describe('profiles list state', () => {
	it('orders the default first and keeps the selection stable', () => {
		const state = loaded(
			emptyProfilesData({
				available: {
					zebra: { repository: 'r1' },
					alpha: { repository: 'r2' },
					middle: { repository: 'r3' },
				},
				defaultProfile: 'middle',
			}),
		);
		expect(orderedProfileNames(state)).toEqual(['middle', 'alpha', 'zebra']);
		expect(state.selectedProfileName).toBe('middle');
		const moved = apply(state, [{ type: 'move-selection', delta: 1 }]);
		expect(moved.selectedProfileName).toBe('alpha');
		// A refresh that drops the selected profile falls back to the first.
		const dropped = reduce(moved, {
			type: 'refreshed',
			workspaces: [],
			profiles: emptyProfilesData({
				available: { zebra: { repository: 'r1' } },
			}),
		});
		expect(dropped.selectedProfileName).toBe('zebra');
	});

	it('exposes the effective profile per workspace (override > default > only)', () => {
		const state = loaded(
			emptyProfilesData({
				available: TWO_PROFILES.available,
				defaultProfile: 'personal',
				workspaceProfiles: { '/home/user/api': 'minimal' },
			}),
		);
		expect(effectiveProfileName(state, '/home/user/api')).toBe('minimal');
		expect(effectiveProfileName(state, '/home/user/web')).toBe('personal');
	});
});

describe('profile form', () => {
	it('creates, types across fields, and validates', () => {
		let state = apply(loaded(), [
			{ type: 'open-profile-form', mode: 'create' },
		]);
		expect(state.profileForm?.mode).toBe('create');
		for (const ch of 'work') {
			state = reduce(state, { type: 'profile-form-input', text: ch });
		}
		state = apply(state, [
			{ type: 'profile-form-focus', delta: 1 },
			{ type: 'profile-form-input', text: 'https://github.com/u/work' },
		]);
		expect(state.profileForm?.fields).toMatchObject({
			name: 'work',
			repository: 'https://github.com/u/work',
		});
		const valid = validateProfileForm(
			state.profileForm as NonNullable<typeof state.profileForm>,
			state.profiles,
		);
		expect(valid).toEqual({
			ok: true,
			name: 'work',
			profile: { repository: 'https://github.com/u/work' },
		});
	});

	it('rejects bad names, empty repos, and duplicates', () => {
		const state = apply(loaded(), [
			{ type: 'open-profile-form', mode: 'create' },
		]);
		const form = state.profileForm as NonNullable<typeof state.profileForm>;
		expect(
			validateProfileForm(
				{ ...form, fields: { ...form.fields, name: 'has space' } },
				state.profiles,
			),
		).toMatchObject({ ok: false });
		expect(
			validateProfileForm(
				{ ...form, fields: { ...form.fields, name: 'ok' } },
				state.profiles,
			),
		).toMatchObject({ ok: false, error: 'Repository is required.' });
		expect(
			validateProfileForm(
				{
					...form,
					fields: { ...form.fields, name: 'personal', repository: 'r' },
				},
				state.profiles,
			),
		).toMatchObject({ ok: false, error: expect.stringContaining('exists') });
	});

	it('edit pre-fills and a rename keeps its own name valid', () => {
		const state = apply(loaded(), [
			{ type: 'open-profile-form', mode: 'edit' },
		]);
		// No default set → alphabetical order → `minimal` is selected.
		const form = state.profileForm as NonNullable<typeof state.profileForm>;
		expect(form.originalName).toBe('minimal');
		expect(form.fields.repository).toBe('https://github.com/u/min');
		// Saving under its own name is not a duplicate.
		expect(validateProfileForm(form, state.profiles)).toMatchObject({
			ok: true,
			name: 'minimal',
		});
	});

	it('owns the keyboard while open', () => {
		const state = apply(loaded(), [
			{ type: 'open-profile-form', mode: 'create' },
		]);
		const ctx = context(state);
		expect(keyToCommand('q', key(), ctx)).toEqual({
			kind: 'profile-form-input',
			text: 'q',
		});
		expect(keyToCommand('', key({ tab: true }), ctx)).toEqual({
			kind: 'profile-form-focus',
			delta: 1,
		});
		expect(keyToCommand('', key({ tab: true, shift: true }), ctx)).toEqual({
			kind: 'profile-form-focus',
			delta: -1,
		});
		expect(keyToCommand('', key({ return: true }), ctx)).toEqual({
			kind: 'profile-form-submit',
		});
		expect(keyToCommand('', key({ escape: true }), ctx)).toEqual({
			kind: 'profile-form-cancel',
		});
	});
});

describe('profile-aware up resolution in the TUI', () => {
	it('asks which profile when several exist without a default', () => {
		const state = loaded();
		const resolution = resolveTuiDotfiles(state, '/home/user/api');
		expect(resolution).toEqual({
			outcome: 'choose',
			names: ['personal', 'minimal'],
		});
	});

	it('resolves the default and flags first use', () => {
		const state = loaded(
			emptyProfilesData({
				available: TWO_PROFILES.available,
				defaultProfile: 'personal',
			}),
		);
		const resolution = resolveTuiDotfiles(state, '/home/user/api');
		expect(resolution).toMatchObject({
			outcome: 'resolved',
			dotfiles: { profileName: 'personal', needsConfirmation: true },
		});
	});

	it('drives the choose-profile modal with j/k and settles on Enter keys', () => {
		let state = apply(loaded(), [
			{
				type: 'open-choose-profile',
				names: ['personal', 'minimal'],
				operation: 'up',
				workspacePath: '/home/user/api',
			},
		]);
		const ctx = context(state);
		expect(ctx.modal).toBe('choose-profile');
		expect(keyToCommand('j', key(), ctx)).toEqual({
			kind: 'modal-move',
			delta: 1,
		});
		expect(keyToCommand('', key({ return: true }), ctx)).toEqual({
			kind: 'confirm-modal',
		});
		expect(keyToCommand('s', key(), ctx)).toEqual({
			kind: 'choose-profile-default',
		});
		expect(keyToCommand('n', key(), ctx)).toEqual({
			kind: 'profile-use-skip',
		});
		state = reduce(state, { type: 'modal-move', delta: 1 });
		expect(state.modal).toMatchObject({ kind: 'choose-profile', index: 1 });
	});

	it('first-use modal offers apply, skip, and cancel', () => {
		const state = apply(loaded(), [
			{
				type: 'open-confirm-profile-use',
				name: 'personal',
				operation: 'rebuild',
				workspacePath: '/home/user/api',
			},
		]);
		const ctx = context(state);
		expect(keyToCommand('', key({ return: true }), ctx)).toEqual({
			kind: 'confirm-modal',
		});
		expect(keyToCommand('n', key(), ctx)).toEqual({
			kind: 'profile-use-skip',
		});
		expect(keyToCommand('', key({ escape: true }), ctx)).toEqual({
			kind: 'close-modal',
		});
	});
});

describe('profiles frames', () => {
	function frame(state: TuiState, columns = 100): string {
		const instance = render(
			<AppView state={state} size={{ columns, rows: 24 }} version="0.0.0" />,
		);
		const text = instance.lastFrame() ?? '';
		instance.unmount();
		return text;
	}

	it('renders the list with default marker and the detail pane', () => {
		const text = frame(
			loaded(
				emptyProfilesData({
					available: TWO_PROFILES.available,
					defaultProfile: 'personal',
				}),
			),
		);
		expect(text).toContain('DOTFILE PROFILES');
		expect(text).toContain('● personal');
		expect(text).toContain('(default)');
		expect(text).toContain('○ minimal');
		expect(text).toContain('Repository');
		expect(text).toContain('https://github.com/u/dotfiles');
		expect(text).toContain('./install.sh');
	});

	it('renders the form, the first-use modal, and the invalid-config screen', () => {
		const formFrame = frame(
			apply(loaded(), [{ type: 'open-profile-form', mode: 'create' }]),
		);
		expect(formFrame).toContain('New dotfiles profile');
		expect(formFrame).toContain('never on this');

		const useFrame = frame(
			apply(loaded(), [
				{
					type: 'open-confirm-profile-use',
					name: 'personal',
					operation: 'up',
					workspacePath: '/home/user/api',
				},
			]),
		);
		expect(useFrame).toContain('First use of profile personal');
		expect(useFrame).toContain('https://github.com/u/dotfiles');
		expect(useFrame).toContain('Nothing executes on this machine');

		const broken = frame(
			loaded(
				emptyProfilesData({
					problem: {
						code: 'PROFILE_CONFIG_INVALID',
						summary: 'The Bring profile config is not valid JSON.',
						remedy: 'Fix /home/u/.config/bring/config.json',
					},
				}),
			),
		);
		expect(broken).toContain('not valid JSON');
		expect(broken).toContain('Fix /home/u/.config/bring/config.json');
	});

	it('shows the effective profile in the workspace detail pane', () => {
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [makeWorkspace('api', 'running')],
			profiles: emptyProfilesData({
				available: TWO_PROFILES.available,
				defaultProfile: 'personal',
			}),
		});
		state = { ...state, section: 'workspaces' };
		const text = frame(state);
		expect(text).toContain('Profile');
		expect(text).toContain('personal');
	});
});

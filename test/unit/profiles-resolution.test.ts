import { describe, expect, it } from 'vitest';
import {
	type DotfilesRequest,
	resolveRunDotfiles,
} from '../../src/application/profiles.js';
import {
	type ProfileConfig,
	profileFingerprint,
} from '../../src/stores/profile-store.js';
import type { BringState } from '../../src/stores/workspace-store.js';

const EMPTY_STATE: BringState = { schemaVersion: 1, workspaces: [] };

function config(partial: Partial<ProfileConfig>): ProfileConfig {
	return {
		schemaVersion: 1,
		profiles: {},
		workspaceProfiles: {},
		...partial,
	};
}

const TWO_PROFILES = config({
	profiles: {
		personal: {
			repository: 'https://github.com/u/dotfiles',
			installCommand: './install.sh',
		},
		minimal: { repository: 'https://github.com/u/min' },
	},
});

function request(partial: Partial<DotfilesRequest>): DotfilesRequest {
	return { workspacePath: '/w/api', ...partial };
}

describe('resolveRunDotfiles precedence (§15.3)', () => {
	it('--dotfiles none and --profile none skip once', () => {
		expect(
			resolveRunDotfiles(TWO_PROFILES, EMPTY_STATE, {
				workspacePath: '/w/api',
				flagDotfiles: false,
			}),
		).toEqual({ outcome: 'resolved', dotfiles: null });
		expect(
			resolveRunDotfiles(TWO_PROFILES, EMPTY_STATE, {
				workspacePath: '/w/api',
				flagProfile: false,
			}),
		).toEqual({ outcome: 'resolved', dotfiles: null });
	});

	it('an explicit --dotfiles URL beats every profile', () => {
		const result = resolveRunDotfiles(
			config({
				defaultProfile: 'personal',
				profiles: TWO_PROFILES.profiles,
			}),
			EMPTY_STATE,
			request({ flagDotfiles: 'https://github.com/u/other' }),
		);
		expect(result).toEqual({
			outcome: 'resolved',
			dotfiles: { repository: 'https://github.com/u/other', source: 'flag' },
		});
	});

	it('--profile picks a profile and flags unknown names', () => {
		const chosen = resolveRunDotfiles(
			TWO_PROFILES,
			EMPTY_STATE,
			request({ flagProfile: 'minimal' }),
		);
		expect(chosen).toMatchObject({
			outcome: 'resolved',
			dotfiles: {
				repository: 'https://github.com/u/min',
				source: 'profile',
				profileName: 'minimal',
				needsConfirmation: true,
			},
		});
		const unknown = resolveRunDotfiles(
			TWO_PROFILES,
			EMPTY_STATE,
			request({ flagProfile: 'ghost' }),
		);
		expect(unknown).toMatchObject({
			outcome: 'failed',
			problem: { code: 'USAGE_ERROR' },
		});
	});

	it('workspace override beats the global default', () => {
		const result = resolveRunDotfiles(
			config({
				defaultProfile: 'personal',
				profiles: TWO_PROFILES.profiles,
				workspaceProfiles: { '/w/api': 'minimal' },
			}),
			EMPTY_STATE,
			request({}),
		);
		expect(result).toMatchObject({
			outcome: 'resolved',
			dotfiles: { profileName: 'minimal' },
		});
	});

	it('falls back to the default, then the only profile', () => {
		const viaDefault = resolveRunDotfiles(
			config({ defaultProfile: 'personal', profiles: TWO_PROFILES.profiles }),
			EMPTY_STATE,
			request({}),
		);
		expect(viaDefault).toMatchObject({
			outcome: 'resolved',
			dotfiles: { profileName: 'personal', installCommand: './install.sh' },
		});
		const only = resolveRunDotfiles(
			config({
				profiles: { solo: { repository: 'https://github.com/u/solo' } },
			}),
			EMPTY_STATE,
			request({}),
		);
		expect(only).toMatchObject({
			outcome: 'resolved',
			dotfiles: { profileName: 'solo' },
		});
	});

	it('several profiles without a default require a choice', () => {
		expect(resolveRunDotfiles(TWO_PROFILES, EMPTY_STATE, request({}))).toEqual({
			outcome: 'choose',
			names: ['personal', 'minimal'],
		});
	});

	it('zero profiles fall back to the legacy remembered URL, else nothing', () => {
		const legacy = resolveRunDotfiles(
			config({}),
			{ ...EMPTY_STATE, dotfilesRepository: 'https://github.com/u/legacy' },
			request({}),
		);
		expect(legacy).toEqual({
			outcome: 'resolved',
			dotfiles: {
				repository: 'https://github.com/u/legacy',
				source: 'remembered',
			},
		});
		expect(resolveRunDotfiles(config({}), EMPTY_STATE, request({}))).toEqual({
			outcome: 'resolved',
			dotfiles: null,
		});
	});

	it('a matching confirmation clears needsConfirmation; an edit revives it', () => {
		const profile = TWO_PROFILES.profiles.personal;
		if (profile === undefined) {
			throw new Error('fixture missing');
		}
		const confirmedState: BringState = {
			...EMPTY_STATE,
			profileConfirmations: { personal: profileFingerprint(profile) },
		};
		const confirmed = resolveRunDotfiles(
			config({ defaultProfile: 'personal', profiles: TWO_PROFILES.profiles }),
			confirmedState,
			request({}),
		);
		expect(confirmed).toMatchObject({ outcome: 'resolved' });
		if (confirmed.outcome === 'resolved') {
			expect(confirmed.dotfiles?.needsConfirmation).toBeUndefined();
		}
		const edited = resolveRunDotfiles(
			config({
				defaultProfile: 'personal',
				profiles: {
					personal: { ...profile, installCommand: './evil-new-script.sh' },
				},
			}),
			confirmedState,
			request({}),
		);
		expect(edited).toMatchObject({
			outcome: 'resolved',
			dotfiles: { needsConfirmation: true },
		});
	});
});

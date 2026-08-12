import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assignWorkspaceProfile,
	deleteProfile,
	ensureProfileConfig,
	loadProfileConfig,
	profileConfigPath,
	profileFingerprint,
	saveProfileConfig,
	setDefaultProfile,
	upsertProfile,
} from '../../src/stores/profile-store.js';
import {
	loadState,
	rememberDotfilesRepository,
} from '../../src/stores/workspace-store.js';

function tempFiles(): { configFile: string; stateFile: string } {
	const dir = mkdtempSync(join(tmpdir(), 'bring-profiles-'));
	return {
		configFile: join(dir, 'config.json'),
		stateFile: join(dir, 'state.json'),
	};
}

import type { ProfileConfig } from '../../src/stores/profile-store.js';

const VALID: ProfileConfig = {
	schemaVersion: 1,
	defaultProfile: 'personal',
	profiles: {
		personal: {
			repository: 'https://github.com/u/dotfiles',
			installCommand: './install.sh',
			targetPath: '~/dotfiles',
		},
		minimal: { repository: 'https://github.com/u/dotfiles-min' },
	},
	workspaceProfiles: { '/work/api': 'minimal' },
};

describe('profile config store', () => {
	it('computes the config path under the XDG config dir', () => {
		expect(profileConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(
			'/xdg/bring/config.json',
		);
		expect(profileConfigPath({ HOME: '/home/u' })).toBe(
			'/home/u/.config/bring/config.json',
		);
	});

	it('treats a missing file as zero profiles', () => {
		const { configFile } = tempFiles();
		const result = loadProfileConfig(configFile);
		expect(result).toEqual({
			ok: true,
			config: { schemaVersion: 1, profiles: {}, workspaceProfiles: {} },
		});
	});

	it('round-trips a valid config', () => {
		const { configFile } = tempFiles();
		writeFileSync(configFile, JSON.stringify(VALID));
		const result = loadProfileConfig(configFile);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config).toEqual(VALID);
		}
	});

	it.each([
		['{broken', 'not valid JSON'],
		['[]', 'must be a JSON object'],
		[JSON.stringify({ schemaVersion: 2, profiles: {} }), 'schemaVersion'],
		[
			JSON.stringify({ schemaVersion: 1, profiles: { 'bad name!': {} } }),
			'invalid',
		],
		[
			JSON.stringify({ schemaVersion: 1, profiles: { a: {} } }),
			'non-empty `repository`',
		],
		[
			JSON.stringify({
				schemaVersion: 1,
				profiles: { a: { repository: 'r', installCommand: 5 } },
			}),
			'must be a string',
		],
		[
			JSON.stringify({
				schemaVersion: 1,
				profiles: { a: { repository: 'r' } },
				defaultProfile: 'ghost',
			}),
			'defaultProfile',
		],
		[
			JSON.stringify({
				schemaVersion: 1,
				profiles: { a: { repository: 'r' } },
				workspaceProfiles: { '/w': 'ghost' },
			}),
			'not a configured profile',
		],
	])('rejects invalid config %#: mentions %s', (raw, expectedText) => {
		const { configFile } = tempFiles();
		writeFileSync(configFile, raw);
		const result = loadProfileConfig(configFile);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.problem.code).toBe('PROFILE_CONFIG_INVALID');
			expect(result.problem.summary).toContain(expectedText);
		}
	});

	it('writes pretty JSON with a trailing newline', () => {
		const { configFile } = tempFiles();
		saveProfileConfig(configFile, {
			schemaVersion: 1,
			profiles: {},
			workspaceProfiles: {},
		});
		const raw = readFileSync(configFile, 'utf8');
		expect(raw.endsWith('\n')).toBe(true);
		expect(raw).toContain('  "schemaVersion": 1');
	});
});

describe('legacy A6 migration', () => {
	it('seeds the config from the remembered dotfiles URL exactly once', () => {
		const { configFile, stateFile } = tempFiles();
		rememberDotfilesRepository(stateFile, 'https://github.com/u/dotfiles');
		const first = ensureProfileConfig(configFile, stateFile);
		expect(first.ok).toBe(true);
		expect(first.migrated).toBe(true);
		if (first.ok) {
			expect(first.config.defaultProfile).toBe('default');
			expect(first.config.profiles.default?.repository).toBe(
				'https://github.com/u/dotfiles',
			);
		}
		// The legacy field survives (downgrade safety), but a second load
		// reads the file rather than migrating again.
		expect(loadState(stateFile).dotfilesRepository).toBe(
			'https://github.com/u/dotfiles',
		);
		const second = ensureProfileConfig(configFile, stateFile);
		expect(second.migrated).toBeUndefined();
	});

	it('does nothing without a legacy URL', () => {
		const { configFile, stateFile } = tempFiles();
		const result = ensureProfileConfig(configFile, stateFile);
		expect(result.ok).toBe(true);
		expect(result.migrated).toBeUndefined();
		if (result.ok) {
			expect(result.config.profiles).toEqual({});
		}
	});
});

describe('profile mutations', () => {
	function seeded(): { configFile: string; stateFile: string } {
		const files = tempFiles();
		saveProfileConfig(files.configFile, structuredClone(VALID));
		return files;
	}

	it('creates a profile and rejects duplicates', () => {
		const { configFile, stateFile } = seeded();
		const created = upsertProfile(configFile, stateFile, 'work', {
			repository: 'https://github.com/u/work-dotfiles',
		});
		expect(created.ok).toBe(true);
		expect(created.config?.profiles.work?.repository).toBe(
			'https://github.com/u/work-dotfiles',
		);
		const duplicate = upsertProfile(configFile, stateFile, 'work', {
			repository: 'x',
		});
		expect(duplicate.ok).toBe(false);
		expect(duplicate.message).toContain('already exists');
	});

	it('rejects invalid names', () => {
		const { configFile, stateFile } = seeded();
		const result = upsertProfile(configFile, stateFile, 'no spaces', {
			repository: 'r',
		});
		expect(result.ok).toBe(false);
	});

	it('renames a profile, carrying default and assignments along', () => {
		const { configFile, stateFile } = seeded();
		const result = upsertProfile(
			configFile,
			stateFile,
			'lean',
			{ repository: 'https://github.com/u/dotfiles-min' },
			'minimal',
		);
		expect(result.ok).toBe(true);
		expect(result.config?.profiles.minimal).toBeUndefined();
		expect(result.config?.workspaceProfiles['/work/api']).toBe('lean');
	});

	it('deletes a profile plus its default status and assignments', () => {
		const { configFile, stateFile } = seeded();
		const result = deleteProfile(configFile, stateFile, 'personal');
		expect(result.ok).toBe(true);
		expect(result.config?.defaultProfile).toBeUndefined();
		expect(result.config?.profiles.personal).toBeUndefined();
		const gone = deleteProfile(configFile, stateFile, 'personal');
		expect(gone.ok).toBe(false);
	});

	it('sets and clears the default profile', () => {
		const { configFile, stateFile } = seeded();
		expect(setDefaultProfile(configFile, stateFile, 'minimal').ok).toBe(true);
		const loaded = loadProfileConfig(configFile);
		expect(loaded.ok && loaded.config.defaultProfile).toBe('minimal');
		expect(setDefaultProfile(configFile, stateFile, null).ok).toBe(true);
		const cleared = loadProfileConfig(configFile);
		expect(cleared.ok && cleared.config.defaultProfile).toBeUndefined();
		expect(setDefaultProfile(configFile, stateFile, 'ghost').ok).toBe(false);
	});

	it('assigns and removes workspace overrides', () => {
		const { configFile, stateFile } = seeded();
		expect(
			assignWorkspaceProfile(configFile, stateFile, '/w/new', 'personal').ok,
		).toBe(true);
		const loaded = loadProfileConfig(configFile);
		expect(loaded.ok && loaded.config.workspaceProfiles['/w/new']).toBe(
			'personal',
		);
		expect(
			assignWorkspaceProfile(configFile, stateFile, '/w/new', null).ok,
		).toBe(true);
		const cleared = loadProfileConfig(configFile);
		expect(
			cleared.ok && cleared.config.workspaceProfiles['/w/new'],
		).toBeUndefined();
	});
});

describe('profile fingerprint', () => {
	it('changes when any shown field changes', () => {
		const base = profileFingerprint({ repository: 'r' });
		expect(profileFingerprint({ repository: 'r' })).toBe(base);
		expect(profileFingerprint({ repository: 'r2' })).not.toBe(base);
		expect(
			profileFingerprint({ repository: 'r', installCommand: './i' }),
		).not.toBe(base);
		expect(profileFingerprint({ repository: 'r', targetPath: '~/d' })).not.toBe(
			base,
		);
	});
});

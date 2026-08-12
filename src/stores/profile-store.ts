import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BringProblem } from '../core/errors.js';
import { bringConfigDir } from './paths.js';
import { loadState } from './workspace-store.js';

// Dotfiles profile configuration (P3-01/P3-02, spec §15). Unlike state.json
// — Bring's own memory, where corruption silently recovers to empty — this
// file is USER intent. A config Bring cannot understand must fail loudly
// (spec §15.4 "validate the config schema before use"), never be ignored:
// silently skipping a broken config would run containers without the
// dotfiles the user believes are applied.

export interface DotfilesProfile {
	/** Git repository the upstream CLI clones (the only required field). */
	repository: string;
	/** Runs INSIDE the container via the upstream CLI — never on the host. */
	installCommand?: string;
	targetPath?: string;
}

export interface ProfileConfig {
	schemaVersion: 1;
	defaultProfile?: string;
	profiles: Record<string, DotfilesProfile>;
	/** Workspace root path → profile name (spec §15.2). */
	workspaceProfiles: Record<string, string>;
}

export type ProfileConfigResult =
	| { ok: true; config: ProfileConfig }
	| { ok: false; problem: BringProblem };

export const EMPTY_PROFILE_CONFIG: ProfileConfig = {
	schemaVersion: 1,
	profiles: {},
	workspaceProfiles: {},
};

/** Profile names stay shell-, path-, and flag-safe. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function profileConfigPath(env: NodeJS.ProcessEnv): string {
	return join(bringConfigDir(env), 'config.json');
}

export function loadProfileConfig(configFile: string): ProfileConfigResult {
	let raw: string;
	try {
		raw = readFileSync(configFile, 'utf8');
	} catch {
		// A missing config is the normal zero-profiles case, not an error.
		return { ok: true, config: structuredClone(EMPTY_PROFILE_CONFIG) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return invalid(
			configFile,
			`is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return validateProfileConfig(configFile, parsed);
}

function validateProfileConfig(
	configFile: string,
	parsed: unknown,
): ProfileConfigResult {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return invalid(configFile, 'must be a JSON object');
	}
	const candidate = parsed as Partial<ProfileConfig>;
	if (candidate.schemaVersion !== 1) {
		return invalid(
			configFile,
			`has schemaVersion ${JSON.stringify(candidate.schemaVersion)} — this Bring understands version 1`,
		);
	}
	const profiles: Record<string, DotfilesProfile> = {};
	const rawProfiles = candidate.profiles ?? {};
	if (typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
		return invalid(configFile, 'field `profiles` must be an object');
	}
	for (const [name, value] of Object.entries(rawProfiles)) {
		if (!PROFILE_NAME_PATTERN.test(name)) {
			return invalid(
				configFile,
				`profile name ${JSON.stringify(name)} is invalid — use letters, digits, dots, dashes, underscores`,
			);
		}
		if (typeof value !== 'object' || value === null) {
			return invalid(configFile, `profile \`${name}\` must be an object`);
		}
		const profile = value as Partial<DotfilesProfile>;
		if (
			typeof profile.repository !== 'string' ||
			profile.repository.trim() === ''
		) {
			return invalid(
				configFile,
				`profile \`${name}\` needs a non-empty \`repository\``,
			);
		}
		for (const field of ['installCommand', 'targetPath'] as const) {
			const fieldValue = profile[field];
			if (fieldValue !== undefined && typeof fieldValue !== 'string') {
				return invalid(
					configFile,
					`profile \`${name}\` field \`${field}\` must be a string`,
				);
			}
		}
		profiles[name] = {
			repository: profile.repository,
			...(profile.installCommand !== undefined &&
			profile.installCommand.trim() !== ''
				? { installCommand: profile.installCommand }
				: {}),
			...(profile.targetPath !== undefined && profile.targetPath.trim() !== ''
				? { targetPath: profile.targetPath }
				: {}),
		};
	}
	if (
		candidate.defaultProfile !== undefined &&
		profiles[candidate.defaultProfile] === undefined
	) {
		return invalid(
			configFile,
			`defaultProfile \`${candidate.defaultProfile}\` does not name a configured profile`,
		);
	}
	const workspaceProfiles: Record<string, string> = {};
	const rawAssignments = candidate.workspaceProfiles ?? {};
	if (typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) {
		return invalid(configFile, 'field `workspaceProfiles` must be an object');
	}
	for (const [path, name] of Object.entries(rawAssignments)) {
		if (typeof name !== 'string' || profiles[name] === undefined) {
			return invalid(
				configFile,
				`workspace \`${path}\` is assigned to \`${String(name)}\`, which is not a configured profile`,
			);
		}
		workspaceProfiles[path] = name;
	}
	return {
		ok: true,
		config: {
			schemaVersion: 1,
			...(candidate.defaultProfile !== undefined
				? { defaultProfile: candidate.defaultProfile }
				: {}),
			profiles,
			workspaceProfiles,
		},
	};
}

function invalid(configFile: string, detail: string): ProfileConfigResult {
	return {
		ok: false,
		problem: {
			code: 'PROFILE_CONFIG_INVALID',
			summary: `The Bring profile config ${detail}.`,
			remedy: `Fix ${configFile} by hand, or delete it to start over.`,
		},
	};
}

export function saveProfileConfig(
	configFile: string,
	config: ProfileConfig,
): void {
	mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
	const temp = `${configFile}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, configFile);
}

/**
 * Load the profile config, seeding it once from the pre-Phase-3 remembered
 * dotfiles URL (amendment A6 said profiles subsume it and its URL "is the
 * natural seed for the default profile"). The legacy state field is left in
 * place so a downgrade to 0.2.x keeps working; once a config file exists it
 * is never consulted again by the profile machinery.
 */
export function ensureProfileConfig(
	configFile: string,
	stateFile: string,
): ProfileConfigResult & { migrated?: boolean } {
	if (existsSync(configFile)) {
		return loadProfileConfig(configFile);
	}
	const legacy = loadState(stateFile).dotfilesRepository;
	if (legacy === undefined) {
		return { ok: true, config: structuredClone(EMPTY_PROFILE_CONFIG) };
	}
	const config: ProfileConfig = {
		schemaVersion: 1,
		defaultProfile: 'default',
		profiles: { default: { repository: legacy } },
		workspaceProfiles: {},
	};
	saveProfileConfig(configFile, config);
	return { ok: true, config, migrated: true };
}

export interface ProfileMutationResult {
	ok: boolean;
	message: string;
	config?: ProfileConfig;
}

/** Create or update a profile; `originalName` renames an existing one. */
export function upsertProfile(
	configFile: string,
	stateFile: string,
	name: string,
	profile: DotfilesProfile,
	originalName?: string,
): ProfileMutationResult {
	const loaded = ensureProfileConfig(configFile, stateFile);
	if (!loaded.ok) {
		return { ok: false, message: loaded.problem.summary };
	}
	const config = loaded.config;
	if (!PROFILE_NAME_PATTERN.test(name)) {
		return {
			ok: false,
			message: `Profile name ${JSON.stringify(name)} is invalid — use letters, digits, dots, dashes, underscores.`,
		};
	}
	const creating = originalName === undefined;
	if (creating && config.profiles[name] !== undefined) {
		return { ok: false, message: `A profile named ${name} already exists.` };
	}
	if (!creating && config.profiles[originalName] === undefined) {
		return { ok: false, message: `No profile named ${originalName} exists.` };
	}
	if (
		!creating &&
		originalName !== name &&
		config.profiles[name] !== undefined
	) {
		return { ok: false, message: `A profile named ${name} already exists.` };
	}
	if (!creating && originalName !== name) {
		delete config.profiles[originalName];
		if (config.defaultProfile === originalName) {
			config.defaultProfile = name;
		}
		for (const [path, assigned] of Object.entries(config.workspaceProfiles)) {
			if (assigned === originalName) {
				config.workspaceProfiles[path] = name;
			}
		}
	}
	config.profiles[name] = profile;
	saveProfileConfig(configFile, config);
	return {
		ok: true,
		message: creating ? `Profile ${name} created.` : `Profile ${name} saved.`,
		config,
	};
}

/** Delete a profile plus its default status and workspace assignments. */
export function deleteProfile(
	configFile: string,
	stateFile: string,
	name: string,
): ProfileMutationResult {
	const loaded = ensureProfileConfig(configFile, stateFile);
	if (!loaded.ok) {
		return { ok: false, message: loaded.problem.summary };
	}
	const config = loaded.config;
	if (config.profiles[name] === undefined) {
		return { ok: false, message: `No profile named ${name} exists.` };
	}
	delete config.profiles[name];
	if (config.defaultProfile === name) {
		delete config.defaultProfile;
	}
	for (const [path, assigned] of Object.entries(config.workspaceProfiles)) {
		if (assigned === name) {
			delete config.workspaceProfiles[path];
		}
	}
	saveProfileConfig(configFile, config);
	return { ok: true, message: `Profile ${name} deleted.`, config };
}

/** Set (or with null, clear) the global default profile. */
export function setDefaultProfile(
	configFile: string,
	stateFile: string,
	name: string | null,
): ProfileMutationResult {
	const loaded = ensureProfileConfig(configFile, stateFile);
	if (!loaded.ok) {
		return { ok: false, message: loaded.problem.summary };
	}
	const config = loaded.config;
	if (name !== null && config.profiles[name] === undefined) {
		return { ok: false, message: `No profile named ${name} exists.` };
	}
	if (name === null) {
		delete config.defaultProfile;
	} else {
		config.defaultProfile = name;
	}
	saveProfileConfig(configFile, config);
	return {
		ok: true,
		message:
			name === null
				? 'Default profile cleared.'
				: `${name} is now the default profile.`,
		config,
	};
}

/** Assign a profile to a workspace, or with null remove the override. */
export function assignWorkspaceProfile(
	configFile: string,
	stateFile: string,
	workspacePath: string,
	name: string | null,
): ProfileMutationResult {
	const loaded = ensureProfileConfig(configFile, stateFile);
	if (!loaded.ok) {
		return { ok: false, message: loaded.problem.summary };
	}
	const config = loaded.config;
	if (name !== null && config.profiles[name] === undefined) {
		return { ok: false, message: `No profile named ${name} exists.` };
	}
	if (name === null) {
		delete config.workspaceProfiles[workspacePath];
	} else {
		config.workspaceProfiles[workspacePath] = name;
	}
	saveProfileConfig(configFile, config);
	return {
		ok: true,
		message:
			name === null
				? 'Workspace profile override removed.'
				: `Workspace assigned to profile ${name}.`,
		config,
	};
}

/**
 * First-use fingerprint (spec §15.4): confirmation covers the exact
 * repository + install command + target path the user was shown. Any edit
 * to those re-triggers the confirmation.
 */
export function profileFingerprint(profile: DotfilesProfile): string {
	return JSON.stringify([
		profile.repository,
		profile.installCommand ?? '',
		profile.targetPath ?? '',
	]);
}

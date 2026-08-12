import type { BringProblem } from '../core/errors.js';
import {
	type DotfilesProfile,
	type ProfileConfig,
	profileFingerprint,
} from '../stores/profile-store.js';
import type { BringState } from '../stores/workspace-store.js';

// Profile precedence (P3-03, spec §15.3):
//   --profile flag > workspace override > global default > only profile
//   > (legacy remembered URL, A6) > no Bring-managed dotfiles.
// Resolution is pure — callers own prompting, modals, and persistence.

export interface ResolvedDotfiles {
	repository: string;
	installCommand?: string;
	targetPath?: string;
	/**
	 * flag: explicit --dotfiles URL (A6 behavior, remembered on success).
	 * profile: a configured profile (capability-probed on first use).
	 * remembered: the legacy A6 URL — only reachable with no config file.
	 */
	source: 'flag' | 'profile' | 'remembered';
	profileName?: string;
	/** §15.4: show repository + install command before this run proceeds. */
	needsConfirmation?: boolean;
}

export type DotfilesResolution =
	| { outcome: 'resolved'; dotfiles: ResolvedDotfiles | null }
	/** Several profiles, no default: interactive pick or --profile required. */
	| { outcome: 'choose'; names: string[] }
	| { outcome: 'failed'; problem: BringProblem };

export interface DotfilesRequest {
	/** URL applies once + remembers (A6); false = `--dotfiles none`. */
	flagDotfiles?: string | false;
	/** Profile name; false = `--profile none` skips Bring dotfiles once. */
	flagProfile?: string | false;
	workspacePath: string;
}

export function resolveRunDotfiles(
	config: ProfileConfig,
	state: BringState,
	request: DotfilesRequest,
): DotfilesResolution {
	if (request.flagDotfiles === false || request.flagProfile === false) {
		return { outcome: 'resolved', dotfiles: null };
	}
	if (request.flagDotfiles !== undefined) {
		return {
			outcome: 'resolved',
			dotfiles: { repository: request.flagDotfiles, source: 'flag' },
		};
	}
	if (request.flagProfile !== undefined) {
		const profile = config.profiles[request.flagProfile];
		if (profile === undefined) {
			const names = Object.keys(config.profiles);
			return {
				outcome: 'failed',
				problem: {
					code: 'USAGE_ERROR',
					summary: `No dotfiles profile named ${request.flagProfile} exists.`,
					remedy:
						names.length === 0
							? 'Create one in the TUI: bring profiles'
							: `Configured profiles: ${names.join(', ')}`,
				},
			};
		}
		return {
			outcome: 'resolved',
			dotfiles: fromProfile(request.flagProfile, profile, state),
		};
	}

	const assigned = config.workspaceProfiles[request.workspacePath];
	if (assigned !== undefined) {
		const profile = config.profiles[assigned];
		// Validation guarantees assignments point at real profiles.
		if (profile !== undefined) {
			return {
				outcome: 'resolved',
				dotfiles: fromProfile(assigned, profile, state),
			};
		}
	}
	if (config.defaultProfile !== undefined) {
		const profile = config.profiles[config.defaultProfile];
		if (profile !== undefined) {
			return {
				outcome: 'resolved',
				dotfiles: fromProfile(config.defaultProfile, profile, state),
			};
		}
	}
	const names = Object.keys(config.profiles);
	if (names.length === 1) {
		const only = names[0] as string;
		return {
			outcome: 'resolved',
			dotfiles: fromProfile(
				only,
				config.profiles[only] as DotfilesProfile,
				state,
			),
		};
	}
	if (names.length > 1) {
		return { outcome: 'choose', names };
	}
	// Zero profiles: the legacy remembered URL still applies until a config
	// file exists (ensureProfileConfig migrates it into one on first write).
	if (state.dotfilesRepository !== undefined) {
		return {
			outcome: 'resolved',
			dotfiles: { repository: state.dotfilesRepository, source: 'remembered' },
		};
	}
	return { outcome: 'resolved', dotfiles: null };
}

function fromProfile(
	name: string,
	profile: DotfilesProfile,
	state: BringState,
): ResolvedDotfiles {
	const confirmed =
		state.profileConfirmations?.[name] === profileFingerprint(profile);
	return {
		repository: profile.repository,
		...(profile.installCommand !== undefined
			? { installCommand: profile.installCommand }
			: {}),
		...(profile.targetPath !== undefined
			? { targetPath: profile.targetPath }
			: {}),
		source: 'profile',
		profileName: name,
		...(confirmed ? {} : { needsConfirmation: true }),
	};
}

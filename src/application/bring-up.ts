import { basename } from 'node:path';
import {
	detectUpFlags,
	parseUpResult,
	runUp,
	type UpFlags,
} from '../adapters/devcontainer-cli.js';
import { classifyDevcontainerFailure } from '../core/errors.js';
import type { OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import { writeOperationLog } from '../stores/log-store.js';
import { acquireOperationLock } from '../stores/op-lock.js';
import { profileFingerprint } from '../stores/profile-store.js';
import {
	rememberDotfilesRepository,
	rememberProfileConfirmation,
	rememberWorkspace,
} from '../stores/workspace-store.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import type { ResolvedDotfiles } from './profiles.js';
import { resultBuilder } from './results.js';

export interface UpOptions {
	config?: string;
	/** True for `bring rebuild`: replace the existing container. */
	rebuild?: boolean;
	noCache?: boolean;
	/**
	 * Dotfiles for this run, already resolved by the caller through the
	 * §15.3 precedence chain (application/profiles.ts) — including any
	 * first-use confirmation. null/undefined = no Bring-managed dotfiles.
	 */
	dotfiles?: ResolvedDotfiles | null;
}

/**
 * Start (or rebuild) a workspace (P1-19/P1-22, workflow in spec §10.5).
 * Idempotent: an already-running workspace is a fast success, not an error.
 * The raw child output is always persisted for `bring logs`.
 */
export async function bringUp(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	options: UpOptions = {},
): Promise<OperationResult> {
	const operation = options.rebuild === true ? 'rebuild' : 'up';
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, operation, workspace, name);
	ctx.emit({ type: 'started', operation, workspaceName: name });
	ctx.emit({
		type: 'stage',
		stage: 'validating',
		message: `Checking ${name}…`,
	});

	// Capability probing (P3-04): a remembered URL or an already-confirmed
	// profile was validated on this machine when it was set/confirmed, so
	// only rebuild, an explicit --dotfiles, and a profile's first use pay
	// for the probe.
	const dotfiles = options.dotfiles ?? null;
	const probeDotfiles =
		dotfiles !== null &&
		(dotfiles.source === 'flag' || dotfiles.needsConfirmation === true);
	if (options.rebuild === true || probeDotfiles) {
		const flags = await detectUpFlags(ctx.devcontainerExe, { env: ctx.env });
		if (options.rebuild === true) {
			const supported =
				flags?.replace === true && (options.noCache !== true || flags.noCache);
			if (!supported) {
				return fail({
					code: 'UNSUPPORTED_CAPABILITY',
					summary:
						'The installed Dev Containers CLI does not support the rebuild flags Bring needs.',
					remedy: 'npm install -g @devcontainers/cli@latest',
				});
			}
		}
		if (probeDotfiles) {
			const missing =
				flags?.dotfiles !== true
					? '--dotfiles-repository'
					: dotfiles.installCommand !== undefined &&
							flags.dotfilesInstall !== true
						? '--dotfiles-install-command'
						: dotfiles.targetPath !== undefined && flags.dotfilesTarget !== true
							? '--dotfiles-target-path'
							: null;
			if (missing !== null) {
				return fail({
					code: 'UNSUPPORTED_CAPABILITY',
					summary: `The installed Dev Containers CLI does not support ${missing}.`,
					remedy: 'npm install -g @devcontainers/cli@latest',
				});
			}
		}
	}

	const lock = acquireOperationLock(ctx.stateDir, workspace.identity);
	if (!lock.ok) {
		return fail({
			code: 'OPERATION_CONFLICT',
			summary: `Another Bring operation (pid ${lock.holderPid}) is already working on ${name}.`,
		});
	}

	try {
		const before = await getSnapshot(ctx, workspace);
		if (!before.ok) {
			return fail(before.problem);
		}
		if (before.snapshot.status === 'running' && options.rebuild !== true) {
			ctx.emit({ type: 'stage', stage: 'ready', message: `${name} is ready` });
			return finish({
				outcome: 'success',
				message: `${name} is already running`,
				containerIds: before.snapshot.containerIds,
			});
		}

		ctx.emit({
			type: 'stage',
			stage: options.rebuild === true ? 'building' : 'starting',
			message:
				options.rebuild === true ? `Rebuilding ${name}…` : `Starting ${name}…`,
		});

		const upFlags: UpFlags = {
			config: options.config,
			removeExistingContainer: options.rebuild === true,
			buildNoCache: options.noCache === true,
			dotfilesRepository: dotfiles?.repository,
			dotfilesInstallCommand: dotfiles?.installCommand,
			dotfilesTargetPath: dotfiles?.targetPath,
		};
		const run = await runUp(ctx.devcontainerExe, workspace.rootPath, upFlags, {
			env: ctx.env,
			onOutput: (stream, chunk) => ctx.emit({ type: 'output', stream, chunk }),
		});

		if (run.outcome === 'spawn-failed') {
			return fail({
				code: 'DEPENDENCY_UNREACHABLE',
				summary: `Could not start the devcontainer CLI: ${run.message}`,
				remedy: 'bring doctor',
			});
		}

		const logPath = writeOperationLog(
			ctx.stateDir,
			workspace.identity,
			run.result.combined,
		);

		if (run.result.interrupted) {
			return finish({
				outcome: 'interrupted',
				message: `${operation} was interrupted`,
				problem: {
					code: 'INTERRUPTED',
					summary: `${operation} was interrupted.`,
				},
				logPath,
			});
		}
		if (run.result.exitCode !== 0) {
			return fail(
				classifyDevcontainerFailure(run.result.combined, run.result.exitCode),
				logPath,
			);
		}

		const after = await getSnapshot(ctx, workspace);
		const containerIds = after.ok ? after.snapshot.containerIds : [];
		const parsed = parseUpResult(run.result.stdout);
		if (parsed?.containerId !== undefined && containerIds.length === 0) {
			containerIds.push(parsed.containerId);
		}
		rememberWorkspace(ctx.stateFile, workspace);
		if (dotfiles?.source === 'flag') {
			rememberDotfilesRepository(ctx.stateFile, dotfiles.repository);
		}
		// A successful run with a profile proves both the shown-and-accepted
		// content and this machine's CLI capability — record it AFTER success
		// so a capability failure keeps prompting (and probing) next time.
		if (dotfiles?.source === 'profile' && dotfiles.profileName !== undefined) {
			rememberProfileConfirmation(
				ctx.stateFile,
				dotfiles.profileName,
				profileFingerprint({
					repository: dotfiles.repository,
					...(dotfiles.installCommand !== undefined
						? { installCommand: dotfiles.installCommand }
						: {}),
					...(dotfiles.targetPath !== undefined
						? { targetPath: dotfiles.targetPath }
						: {}),
				}),
			);
		}
		ctx.emit({ type: 'stage', stage: 'ready', message: `${name} is ready` });
		return finish({
			outcome: 'success',
			message: `${name} ready`,
			containerIds,
			logPath,
		});
	} finally {
		lock.release();
	}
}

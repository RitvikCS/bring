import { basename } from 'node:path';
import { runExec } from '../adapters/devcontainer-cli.js';
import type { OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import { resultBuilder } from './results.js';

/**
 * `bring shell` (P1-23): interactive `devcontainer exec` with inherited
 * stdio — the child owns the terminal until it exits. Not a mutation, so no
 * lock. The shell's own exit code is passed through in `childExitCode`.
 */
export async function openShell(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	command: readonly string[] = ['bash'],
	config?: string,
): Promise<OperationResult & { childExitCode?: number }> {
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, 'shell', workspace, name);
	ctx.emit({ type: 'started', operation: 'shell', workspaceName: name });

	const before = await getSnapshot(ctx, workspace);
	if (!before.ok) {
		return fail(before.problem);
	}
	if (before.snapshot.status !== 'running') {
		return fail({
			code: 'DEVCONTAINER_FAILED',
			summary: `${name} is not running.`,
			remedy: `bring ${workspace.input || '.'} up`,
		});
	}

	const run = await runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		command,
		{ env: ctx.env, stdio: 'inherit' },
		config,
	);
	if (run.outcome === 'spawn-failed') {
		return fail({
			code: 'DEPENDENCY_UNREACHABLE',
			summary: `Could not start the devcontainer CLI: ${run.message}`,
			remedy: 'bring doctor',
		});
	}
	// 126/127 from exec means the command itself doesn't exist in the
	// container — worth a hint, since `bash` is only a default.
	if (run.result.exitCode === 126 || run.result.exitCode === 127) {
		return {
			...fail({
				code: 'DEVCONTAINER_FAILED',
				summary: `\`${command.join(' ')}\` is not available in ${name}.`,
				remedy: `bring ${workspace.input || '.'} shell -- sh`,
			}),
			childExitCode: run.result.exitCode,
		};
	}
	return {
		...finish({
			outcome: 'success',
			message: `shell in ${name} closed`,
		}),
		childExitCode: run.result.exitCode,
	};
}

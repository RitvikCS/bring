import type { BringProblem } from '../core/errors.js';
import type {
	EmitEvent,
	OperationKind,
	OperationResult,
} from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';

/** Builds results with consistent timing and always emits `completed`. */
export function resultBuilder(
	emit: EmitEvent,
	operation: OperationKind,
	workspace: WorkspaceRef,
	workspaceName: string,
) {
	const startedAt = Date.now();
	const finish = (
		partial: Pick<OperationResult, 'outcome' | 'message'> &
			Partial<Pick<OperationResult, 'containerIds' | 'problem' | 'logPath'>>,
	): OperationResult => {
		const result: OperationResult = {
			operation,
			workspace: workspace.rootPath,
			workspaceName,
			durationMs: Date.now() - startedAt,
			containerIds: [],
			...partial,
		};
		emit({ type: 'completed', result });
		return result;
	};
	return {
		finish,
		fail: (problem: BringProblem, logPath?: string) =>
			finish({ outcome: 'failed', message: problem.summary, problem, logPath }),
	};
}

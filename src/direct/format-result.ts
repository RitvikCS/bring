import type { OperationResult } from '../core/operation-events.js';

const ANSI = {
	green: '\u001b[32m',
	red: '\u001b[31m',
	yellow: '\u001b[33m',
	reset: '\u001b[0m',
} as const;

/**
 * The single final summary line plus guidance (P1-28, spec §10.2/10.3):
 * mark, message, duration — then, on failure, the shortest useful next step.
 * Never the full build log (that's what `bring logs` is for).
 */
export function formatResult(
	result: OperationResult,
	options: { color?: boolean } = {},
): string {
	const paint = (code: keyof typeof ANSI, text: string) =>
		options.color === true ? `${ANSI[code]}${text}${ANSI.reset}` : text;
	const duration = `${(result.durationMs / 1000).toFixed(1)}s`;

	if (result.outcome === 'success') {
		return `${paint('green', '✓')} ${result.message.padEnd(48)} ${duration}`;
	}

	const mark =
		result.outcome === 'interrupted' || result.outcome === 'cancelled'
			? paint('yellow', '✗')
			: paint('red', '✗');
	const lines = [`${mark} ${result.message.padEnd(48)} ${duration}`];
	if (result.problem?.remedy !== undefined) {
		lines.push(`  ${result.problem.remedy}`);
	}
	if (result.logPath !== undefined) {
		const target = result.workspace === process.cwd() ? '.' : result.workspace;
		lines.push(
			`  Run \`bring ${target} logs\` or retry with \`--verbose\` for the full output.`,
		);
	}
	return lines.join('\n');
}

/** The one JSON document a direct command emits in --json mode (spec §10.6). */
export function formatResultJson(
	result: OperationResult & { childExitCode?: number },
): string {
	return JSON.stringify(
		{
			schemaVersion: 1,
			operation: result.operation,
			outcome: result.outcome,
			workspace: result.workspace,
			workspaceName: result.workspaceName,
			durationMs: result.durationMs,
			containerIds: result.containerIds,
			message: result.message,
			...(result.problem === undefined
				? {}
				: {
						error: {
							code: result.problem.code,
							summary: result.problem.summary,
							...(result.problem.remedy === undefined
								? {}
								: { remedy: result.problem.remedy }),
						},
					}),
			...(result.logPath === undefined ? {} : { logPath: result.logPath }),
		},
		null,
		2,
	);
}

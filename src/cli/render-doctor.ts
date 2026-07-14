import type { DoctorCheck, DoctorReport } from '../application/doctor.js';

const MARKS: Record<DoctorCheck['status'], string> = {
	ok: '✓',
	failed: '✗',
	skipped: '-',
};

/**
 * Human doctor output (P1-05, examples in spec §5.6): the aligned check list,
 * then a guidance block per failure. Plain text, no ANSI — doctor output gets
 * pasted into issues and chat, where escape codes turn to noise.
 */
export function renderDoctorHuman(report: DoctorReport): string {
	const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
	const lines = report.checks.map(
		(c) => `${MARKS[c.status]} ${c.label.padEnd(labelWidth)}  ${c.detail}`,
	);

	if (report.healthy) {
		return `${lines.join('\n')}\n\nReady.`;
	}

	const guidance = report.checks
		.filter((c) => c.problem !== undefined)
		.map((c) => {
			const problem = c.problem;
			if (problem === undefined) {
				return '';
			}
			return problem.remedy === undefined
				? problem.summary
				: `${problem.summary}\n\n  ${problem.remedy}`;
		});

	return `${lines.join('\n')}\n\n${guidance.join('\n\n')}\n\nNothing was changed by Bring.`;
}

/**
 * Machine output for --json: stable field names, stable error codes
 * (spec §14.1), never any ANSI. `errorCode` is the first failure's code.
 */
export function renderDoctorJson(report: DoctorReport): string {
	const firstProblem = report.checks.find(
		(c) => c.problem !== undefined,
	)?.problem;
	return JSON.stringify(
		{
			healthy: report.healthy,
			...(firstProblem === undefined ? {} : { errorCode: firstProblem.code }),
			checks: report.checks.map((c) => ({
				id: c.id,
				label: c.label,
				status: c.status,
				detail: c.detail,
				...(c.problem === undefined ? {} : { problem: c.problem }),
			})),
		},
		null,
		2,
	);
}

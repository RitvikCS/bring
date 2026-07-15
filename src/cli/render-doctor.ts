import type { DoctorCheck, DoctorReport } from '../application/doctor.js';

const MARKS: Record<DoctorCheck['status'], string> = {
	ok: '✓',
	failed: '✗',
	skipped: '-',
};

const ANSI = {
	green: '\u001b[32m',
	red: '\u001b[31m',
	dim: '\u001b[2m',
	reset: '\u001b[0m',
} as const;

export interface RenderOptions {
	/**
	 * Callers must only enable this for an interactive terminal: stdout is a
	 * TTY, NO_COLOR is unset, and the user did not ask for --json (spec §18).
	 */
	color?: boolean;
}

/**
 * Human doctor output (P1-05, examples in spec §5.6): the aligned check list,
 * then a guidance block per failure. Defaults to plain text — doctor output
 * gets pasted into issues and chat, where escape codes turn to noise.
 */
export function renderDoctorHuman(
	report: DoctorReport,
	options: RenderOptions = {},
): string {
	const paint = options.color
		? (code: keyof typeof ANSI, text: string) =>
				`${ANSI[code]}${text}${ANSI.reset}`
		: (_code: keyof typeof ANSI, text: string) => text;

	const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
	const lines = report.checks.map((c) => renderCheckLine(c, labelWidth, paint));

	if (report.healthy) {
		return `${lines.join('\n')}\n\n${paint('green', 'Ready.')}`;
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

function renderCheckLine(
	check: DoctorCheck,
	labelWidth: number,
	paint: (code: keyof typeof ANSI, text: string) => string,
): string {
	const line = `${MARKS[check.status]} ${check.label.padEnd(labelWidth)}  ${check.detail}`;
	switch (check.status) {
		case 'ok':
			return `${paint('green', MARKS.ok)}${line.slice(MARKS.ok.length)}`;
		case 'failed':
			return `${paint('red', MARKS.failed)}${line.slice(MARKS.failed.length)}`;
		case 'skipped':
			return paint('dim', line);
	}
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

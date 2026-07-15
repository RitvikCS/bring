// Shared ANSI palette for direct-command output (spec §18: plain by
// default, color only on an interactive terminal). Codes are written as
// \u001b escapes — never raw ESC bytes in source.

export const ANSI = {
	green: '\u001b[32m',
	red: '\u001b[31m',
	yellow: '\u001b[33m',
	cyan: '\u001b[36m',
	dim: '\u001b[2m',
	bold: '\u001b[1m',
	reset: '\u001b[0m',
} as const;

export type AnsiCode = Exclude<keyof typeof ANSI, 'reset'>;

/** Returns a painter that styles text, or passes it through untouched. */
export function makePaint(
	color: boolean,
): (code: AnsiCode, text: string) => string {
	return color
		? (code, text) => `${ANSI[code]}${text}${ANSI.reset}`
		: (_code, text) => text;
}

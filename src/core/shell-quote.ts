/**
 * Quote one argument for the POSIX shell, for commands Bring prints for a
 * person or an agent to paste back (remedies, stop commands). Plain words
 * are left as they are; anything else is single-quoted, so a folder named
 * `my app` or `x; rm -rf ~` stays one harmless argument.
 */
export function shellQuote(argument: string): string {
	if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(argument)) {
		return argument;
	}
	return `'${argument.replaceAll("'", `'\\''`)}'`;
}

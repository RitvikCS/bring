/**
 * Hands the terminal's input to a child process for the duration of a shell
 * session, and reclaims it afterwards.
 *
 * Ink's suspension turns raw mode off and detaches its listeners, but leaves
 * the underlying TTY read running — so the suspended TUI keeps racing the
 * child for every keystroke. On Linux the child virtually always wins; on
 * macOS the parent often does, so keys typed into the shell vanish from it,
 * sit in the parent's stream buffer, and replay as TUI commands the moment
 * input resumes (a buffered `exit⏎` replays as e/x/⏎ — reopen shell, open
 * the remove confirm, confirm it). A stolen Ctrl+D EOF is the same race.
 *
 * Call this AFTER Ink's suspension has begun (raw mode already off) and
 * BEFORE spawning the child. It discards anything already buffered (so
 * stray bytes can't leak into the child's stdin) and pauses stdin, which
 * stops the TTY read at the libuv level — the child becomes the terminal's
 * only reader. The returned function reclaims input: call it after the
 * child has exited and before Ink's resume, to discard anything the parent
 * still captured. Ink reattaches its own listeners afterwards, which
 * restarts reading.
 */
export function handTerminalToChild(
	stdin: NodeJS.ReadStream = process.stdin,
): () => void {
	if (stdin.isTTY !== true) {
		// Tests and non-interactive stdio: nothing is racing, touch nothing.
		return () => {};
	}
	drain(stdin);
	stdin.pause();
	return () => {
		drain(stdin);
	};
}

function drain(stdin: NodeJS.ReadStream): void {
	while (stdin.read() !== null) {
		// Discard: these bytes were typed for the child (or are typeahead),
		// never for the TUI.
	}
}

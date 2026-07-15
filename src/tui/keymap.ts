// The keymap controller (P1-35, bindings in spec §11.3): a total, pure
// mapping from a keystroke plus the UI situation to one semantic command.
// App.tsx executes commands; nothing here touches state or processes, so
// every binding is testable as a plain function call.

export interface KeyInfo {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	return?: boolean;
	escape?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	pageUp?: boolean;
	pageDown?: boolean;
}

/** The parts of the UI situation that change what a key means. */
export interface KeyContext {
	phase: 'loading' | 'doctor-blocked' | 'ready';
	modal: 'help' | 'confirm-remove' | null;
	logViewOpen: boolean;
	operationRunning: boolean;
	/** An operation pane is showing a settled result awaiting dismissal. */
	operationSettled: boolean;
}

export type TuiCommand =
	| { kind: 'quit' }
	| { kind: 'move-selection'; delta: 1 | -1 }
	| { kind: 'move-section'; delta: 1 | -1 }
	| { kind: 'focus-pane'; pane: 'list' | 'detail' }
	| { kind: 'primary' }
	| { kind: 'back' }
	| { kind: 'workspace-up' }
	| { kind: 'workspace-down' }
	| { kind: 'rebuild-or-refresh' }
	| { kind: 'open-shell' }
	| { kind: 'open-logs' }
	| { kind: 'request-remove' }
	| { kind: 'open-help' }
	| { kind: 'close-modal' }
	| { kind: 'confirm-modal' }
	| { kind: 'scroll-logs'; delta: number }
	| { kind: 'dismiss-operation' }
	| { kind: 'retry-doctor' };

export function keyToCommand(
	input: string,
	key: KeyInfo,
	context: KeyContext,
): TuiCommand | null {
	// Doctor-blocked screen (P1-43): retry or leave, nothing else.
	if (context.phase === 'doctor-blocked') {
		if (input === 'r') {
			return { kind: 'retry-doctor' };
		}
		if (input === 'q' || key.escape === true) {
			return { kind: 'quit' };
		}
		return null;
	}
	if (context.phase === 'loading') {
		return input === 'q' ? { kind: 'quit' } : null;
	}

	// Modals swallow everything (spec §11.3: Esc closes; `x` never deletes —
	// removal happens only via Enter inside the confirmation).
	if (context.modal === 'help') {
		return input === 'q' || input === '?' || key.escape === true
			? { kind: 'close-modal' }
			: null;
	}
	if (context.modal === 'confirm-remove') {
		if (key.return === true) {
			return { kind: 'confirm-modal' };
		}
		if (key.escape === true || input === 'q' || input === 'n') {
			return { kind: 'close-modal' };
		}
		return null;
	}

	// Log view: scroll, or leave it (Esc restores the prior view, P1-41).
	if (context.logViewOpen) {
		if (input === 'j' || key.downArrow === true) {
			return { kind: 'scroll-logs', delta: 1 };
		}
		if (input === 'k' || key.upArrow === true) {
			return { kind: 'scroll-logs', delta: -1 };
		}
		if (key.pageDown === true) {
			return { kind: 'scroll-logs', delta: 10 };
		}
		if (key.pageUp === true) {
			return { kind: 'scroll-logs', delta: -10 };
		}
		if (input === 'G') {
			return { kind: 'scroll-logs', delta: Number.MAX_SAFE_INTEGER };
		}
		if (input === 'g') {
			return { kind: 'scroll-logs', delta: -Number.MAX_SAFE_INTEGER };
		}
		if (key.escape === true || input === 'q') {
			return { kind: 'back' };
		}
		if (input === '?') {
			return { kind: 'open-help' };
		}
		return null;
	}

	// A settled operation pane waits for acknowledgement, but logs and help
	// stay reachable (spec §13.5 failure workflow points at the log view).
	if (context.operationSettled) {
		if (key.return === true || key.escape === true || input === 'q') {
			return { kind: 'dismiss-operation' };
		}
		if (input === 'L') {
			return { kind: 'open-logs' };
		}
		if (input === '?') {
			return { kind: 'open-help' };
		}
		return null;
	}

	// Navigation is always available while ready.
	if (input === 'j' || key.downArrow === true) {
		return { kind: 'move-selection', delta: 1 };
	}
	if (input === 'k' || key.upArrow === true) {
		return { kind: 'move-selection', delta: -1 };
	}
	if (key.ctrl === true && input === 'h') {
		return { kind: 'focus-pane', pane: 'list' };
	}
	if (key.ctrl === true && input === 'l') {
		return { kind: 'focus-pane', pane: 'detail' };
	}
	if (input === 'h' || key.leftArrow === true) {
		return { kind: 'move-section', delta: -1 };
	}
	if (input === 'l' || key.rightArrow === true) {
		return { kind: 'move-section', delta: 1 };
	}
	if (input === '?') {
		return { kind: 'open-help' };
	}
	if (key.escape === true) {
		return { kind: 'back' };
	}

	// While a mutation runs, further mutations (and quitting away from the
	// child process) are refused; App surfaces why (spec §13.1: one at a time).
	if (context.operationRunning) {
		if (input === 'L') {
			return { kind: 'open-logs' };
		}
		// Surfaced so App can explain WHY quitting is refused right now.
		if (input === 'q') {
			return { kind: 'quit' };
		}
		return null;
	}

	if (key.return === true) {
		return { kind: 'primary' };
	}
	switch (input) {
		case 'u':
			return { kind: 'workspace-up' };
		case 'd':
			return { kind: 'workspace-down' };
		case 'r':
			return { kind: 'rebuild-or-refresh' };
		case 'e':
			return { kind: 'open-shell' };
		case 'L':
			return { kind: 'open-logs' };
		case 'x':
			return { kind: 'request-remove' };
		case 'q':
			return { kind: 'quit' };
		default:
			return null;
	}
}

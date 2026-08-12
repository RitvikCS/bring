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
	backspace?: boolean;
	tab?: boolean;
}

/** The parts of the UI situation that change what a key means. */
export interface KeyContext {
	phase: 'loading' | 'doctor-blocked' | 'ready';
	/**
	 * Action keys only fire in sections where their target is on screen —
	 * `d` in Images must never act on the invisible Workspaces selection.
	 */
	section: 'workspaces' | 'containers' | 'images' | 'profiles';
	modal:
		| 'help'
		| 'confirm-remove'
		| 'confirm-rebuild'
		| 'confirm-container-remove'
		| 'confirm-image-remove'
		| 'confirm-forget'
		| 'confirm-profile-delete'
		| 'confirm-profile-use'
		| 'choose-profile'
		| 'assign-profile'
		| null;
	logViewOpen: boolean;
	operationRunning: boolean;
	/** An operation pane is showing a settled result awaiting dismissal. */
	operationSettled: boolean;
	filtering: boolean;
	filterActive: boolean;
	detailOpen: boolean;
	/** The Profiles create/edit form owns typed input while open (P3-07). */
	profileFormOpen: boolean;
}

export type TuiCommand =
	| { kind: 'quit' }
	| { kind: 'move-selection'; delta: 1 | -1 }
	| { kind: 'move-section'; delta: 1 | -1 }
	| { kind: 'jump-section'; index: number }
	| { kind: 'focus-next' }
	| { kind: 'focus-pane'; pane: 'list' | 'detail' }
	| { kind: 'primary' }
	| { kind: 'back' }
	| { kind: 'workspace-up' }
	| { kind: 'workspace-down' }
	| { kind: 'rebuild-or-refresh' }
	| { kind: 'open-shell' }
	| { kind: 'open-logs' }
	| { kind: 'request-remove' }
	| { kind: 'request-forget' }
	| { kind: 'toggle-selection' }
	| { kind: 'prune-dangling' }
	| { kind: 'open-filter' }
	| { kind: 'filter-input'; text: string }
	| { kind: 'filter-backspace' }
	| { kind: 'apply-filter' }
	| { kind: 'cancel-filter' }
	| { kind: 'clear-filter' }
	| { kind: 'open-help' }
	| { kind: 'close-modal' }
	| { kind: 'confirm-modal' }
	| { kind: 'scroll-logs'; delta: number }
	| { kind: 'dismiss-operation' }
	| { kind: 'retry-doctor' }
	| { kind: 'profile-new' }
	| { kind: 'profile-edit' }
	| { kind: 'profile-default' }
	| { kind: 'profile-assign' }
	| { kind: 'profile-form-input'; text: string }
	| { kind: 'profile-form-backspace' }
	| { kind: 'profile-form-focus'; delta: 1 | -1 }
	| { kind: 'profile-form-submit' }
	| { kind: 'profile-form-cancel' }
	| { kind: 'modal-move'; delta: 1 | -1 }
	/** In choose-profile: pick the highlighted profile AND make it default. */
	| { kind: 'choose-profile-default' }
	/** In profile-use/choose modals: run the operation without dotfiles. */
	| { kind: 'profile-use-skip' };

export function keyToCommand(
	input: string,
	key: KeyInfo,
	context: KeyContext,
): TuiCommand | null {
	// A Ctrl-modified letter is not that letter: Ctrl+D once arrived after a
	// shell session and read as `d`, stopping the workspace with no confirm.
	// The only Ctrl chords Bring binds are Ctrl+H/Ctrl+L (pane focus), so
	// everything else with Ctrl held is inert. Empty input passes through —
	// special keys (backspace, arrows) may carry flags without a character.
	if (key.ctrl === true && input !== '' && input !== 'h' && input !== 'l') {
		return null;
	}
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
	if (
		context.modal === 'confirm-remove' ||
		context.modal === 'confirm-rebuild' ||
		context.modal === 'confirm-container-remove' ||
		context.modal === 'confirm-image-remove' ||
		context.modal === 'confirm-forget' ||
		context.modal === 'confirm-profile-delete'
	) {
		if (key.return === true) {
			return { kind: 'confirm-modal' };
		}
		if (key.escape === true || input === 'q' || input === 'n') {
			return { kind: 'close-modal' };
		}
		return null;
	}
	// First-use confirmation (§15.4): Enter applies the profile, n runs the
	// operation without dotfiles, Esc cancels the operation entirely.
	if (context.modal === 'confirm-profile-use') {
		if (key.return === true) {
			return { kind: 'confirm-modal' };
		}
		if (input === 'n') {
			return { kind: 'profile-use-skip' };
		}
		if (key.escape === true || input === 'q') {
			return { kind: 'close-modal' };
		}
		return null;
	}
	if (context.modal === 'choose-profile') {
		if (input === 'j' || key.downArrow === true) {
			return { kind: 'modal-move', delta: 1 };
		}
		if (input === 'k' || key.upArrow === true) {
			return { kind: 'modal-move', delta: -1 };
		}
		if (key.return === true) {
			return { kind: 'confirm-modal' };
		}
		if (input === 's') {
			return { kind: 'choose-profile-default' };
		}
		if (input === 'n') {
			return { kind: 'profile-use-skip' };
		}
		if (key.escape === true || input === 'q') {
			return { kind: 'close-modal' };
		}
		return null;
	}
	if (context.modal === 'assign-profile') {
		if (input === 'j' || key.downArrow === true) {
			return { kind: 'modal-move', delta: 1 };
		}
		if (input === 'k' || key.upArrow === true) {
			return { kind: 'modal-move', delta: -1 };
		}
		if (key.return === true) {
			return { kind: 'confirm-modal' };
		}
		if (key.escape === true || input === 'q') {
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

	// The profile form owns the keyboard like the filter does: typed text is
	// content, never a command (P3-07).
	if (context.profileFormOpen) {
		if (key.return === true) {
			return { kind: 'profile-form-submit' };
		}
		if (key.escape === true) {
			return { kind: 'profile-form-cancel' };
		}
		if (key.tab === true) {
			return { kind: 'profile-form-focus', delta: key.shift === true ? -1 : 1 };
		}
		if (key.downArrow === true) {
			return { kind: 'profile-form-focus', delta: 1 };
		}
		if (key.upArrow === true) {
			return { kind: 'profile-form-focus', delta: -1 };
		}
		if (key.backspace === true) {
			return { kind: 'profile-form-backspace' };
		}
		return input !== '' && key.ctrl !== true
			? { kind: 'profile-form-input', text: input }
			: null;
	}

	if (context.filtering) {
		if (key.return === true) {
			return { kind: 'apply-filter' };
		}
		if (key.escape === true) {
			return { kind: 'cancel-filter' };
		}
		if (key.backspace === true) {
			return { kind: 'filter-backspace' };
		}
		return input !== '' && key.ctrl !== true
			? { kind: 'filter-input', text: input }
			: null;
	}

	if (context.filterActive && !context.detailOpen && key.escape === true) {
		return { kind: 'clear-filter' };
	}

	// Navigation is always available while ready.
	if (input === 'j' || key.downArrow === true) {
		return { kind: 'move-selection', delta: 1 };
	}
	if (input === 'k' || key.upArrow === true) {
		return { kind: 'move-selection', delta: -1 };
	}
	// Ctrl+H is ASCII backspace (0x08): terminals deliver it as a backspace
	// keypress with ctrl unset, so the backspace flag IS the Ctrl+H binding.
	if ((key.ctrl === true && input === 'h') || key.backspace === true) {
		return { kind: 'focus-pane', pane: 'list' };
	}
	if (key.ctrl === true && input === 'l') {
		return { kind: 'focus-pane', pane: 'detail' };
	}
	if (key.tab === true) {
		return { kind: 'focus-next' };
	}
	if (/^[1-4]$/.test(input)) {
		return { kind: 'jump-section', index: Number(input) - 1 };
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
	// Every action key is scoped to the sections whose pane can actually show
	// its target; anywhere else the key is dead, never a hidden-pane mutation.
	const { section } = context;
	switch (input) {
		case 'u':
			return section === 'workspaces' ? { kind: 'workspace-up' } : null;
		case 'd':
			return section === 'workspaces' || section === 'containers'
				? { kind: 'workspace-down' }
				: null;
		case 'r':
			return { kind: 'rebuild-or-refresh' };
		case 'e':
			if (section === 'profiles') {
				return { kind: 'profile-edit' };
			}
			return section === 'workspaces' || section === 'containers'
				? { kind: 'open-shell' }
				: null;
		case 'L':
			return section === 'workspaces' ? { kind: 'open-logs' } : null;
		case 'x':
			return { kind: 'request-remove' };
		case 'f':
			return section === 'workspaces' ? { kind: 'request-forget' } : null;
		case 'n':
			return section === 'profiles' ? { kind: 'profile-new' } : null;
		case 's':
			return section === 'profiles' ? { kind: 'profile-default' } : null;
		case 'a':
			return section === 'profiles' ? { kind: 'profile-assign' } : null;
		case ' ':
			return section === 'images' ? { kind: 'toggle-selection' } : null;
		case 'p':
			return section === 'images' ? { kind: 'prune-dangling' } : null;
		case '/':
			return section === 'containers' || section === 'images'
				? { kind: 'open-filter' }
				: null;
		case 'q':
			return { kind: 'quit' };
		default:
			return null;
	}
}

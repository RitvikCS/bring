import type { DoctorReport } from '../application/doctor.js';
import type { BringProblem } from '../core/errors.js';
import type {
	OperationKind,
	OperationResult,
	OperationStage,
} from '../core/operation-events.js';
import type {
	ForwardedPort,
	WorkspaceRef,
	WorkspaceStatus,
} from '../core/types.js';

// TUI state (spec §11.5): a pure reducer over everything the screen shows.
// Effects (doctor, snapshots, operations, the shell) live in App.tsx and
// only talk to this module through actions — which keeps every transition
// unit-testable without rendering a frame.

export type Section = 'workspaces' | 'containers' | 'images' | 'profiles';
export const SECTIONS: readonly Section[] = [
	'workspaces',
	'containers',
	'images',
	'profiles',
];

/** One workspace as the TUI knows it: registry entry + live snapshot. */
export interface TuiWorkspace {
	ref: WorkspaceRef;
	name: string;
	status: WorkspaceStatus;
	lastUsedAt: string;
	containerIds: string[];
	imageNames: string[];
	forwardedPorts: ForwardedPort[];
	/** Set after a failed operation this session (spec §13.5). */
	problem?: BringProblem;
	/**
	 * The current directory has a config but isn't in the registry yet —
	 * shown so first contact with the TUI is never an empty list. Cleared
	 * naturally by the first successful up (which registers it).
	 */
	unregistered?: boolean;
}

export type Modal =
	| { kind: 'help' }
	| { kind: 'confirm-remove'; workspacePath: string };

export interface OperationProgress {
	operation: OperationKind;
	workspacePath: string;
	workspaceName: string;
	/** Stages seen so far, in arrival order — never invented (spec §12.2). */
	stages: { seq: number; stage: OperationStage; message: string }[];
	/** Latest safe line of raw child output. */
	lastOutput: string;
	startedAt: number;
	/** Set once the operation settles; the pane shows its outcome. */
	result?: OperationResult;
}

export interface LogViewState {
	workspaceName: string;
	lines: string[];
	scroll: number;
}

export type Phase = 'loading' | 'doctor-blocked' | 'ready';

export interface TuiState {
	phase: Phase;
	doctorReport: DoctorReport | null;
	section: Section;
	/** Ordered per §12.1; selection tracks rootPath, not index. */
	workspaces: TuiWorkspace[];
	selectedPath: string | null;
	/** Wide layout: which pane has focus. Narrow: detail visible or not. */
	focusedPane: 'list' | 'detail';
	detailOpen: boolean;
	modal: Modal | null;
	logView: LogViewState | null;
	operation: OperationProgress | null;
	/** Bottom-left status line ("✓ ml-platform ready in 8.4s"). */
	statusMessage: string;
	/** The user-wide dotfiles default (A6), shown in the detail pane. */
	dotfilesRepository: string | null;
}

export const INITIAL_STATE: TuiState = {
	phase: 'loading',
	doctorReport: null,
	section: 'workspaces',
	workspaces: [],
	selectedPath: null,
	focusedPane: 'list',
	detailOpen: false,
	modal: null,
	logView: null,
	operation: null,
	statusMessage: 'Checking your setup…',
	dotfilesRepository: null,
};

export type TuiAction =
	| { type: 'doctor-blocked'; report: DoctorReport }
	| {
			type: 'loaded';
			workspaces: TuiWorkspace[];
			dotfilesRepository?: string | null;
	  }
	| {
			type: 'refreshed';
			workspaces: TuiWorkspace[];
			dotfilesRepository?: string | null;
	  }
	| { type: 'retry-loading' }
	| { type: 'move-selection'; delta: 1 | -1 }
	| { type: 'move-section'; delta: 1 | -1 }
	| { type: 'focus-pane'; pane: 'list' | 'detail' }
	| { type: 'open-detail' }
	| { type: 'back' }
	| { type: 'open-help' }
	| { type: 'open-confirm-remove' }
	| { type: 'close-modal' }
	| {
			type: 'operation-started';
			operation: OperationKind;
			workspace: TuiWorkspace;
	  }
	| { type: 'operation-stage'; stage: OperationStage; message: string }
	| { type: 'operation-output'; chunk: string }
	| { type: 'operation-completed'; result: OperationResult }
	| { type: 'dismiss-operation' }
	| { type: 'open-logs'; workspaceName: string; content: string }
	| { type: 'scroll-logs'; delta: number }
	| { type: 'close-logs' }
	| { type: 'status-message'; message: string };

const BUSY: Record<string, WorkspaceStatus> = {
	up: 'starting',
	rebuild: 'rebuilding',
	down: 'stopping',
	remove: 'removing',
};

/** §12.1 list ordering: busy, running, failed, stopped by MRU, missing. */
export function orderWorkspaces(
	workspaces: readonly TuiWorkspace[],
): TuiWorkspace[] {
	return [...workspaces].sort((a, b) => {
		const byRank = statusRank(a.status) - statusRank(b.status);
		if (byRank !== 0) {
			return byRank;
		}
		return b.lastUsedAt.localeCompare(a.lastUsedAt);
	});
}

function statusRank(status: WorkspaceStatus): number {
	switch (status) {
		case 'starting':
		case 'stopping':
		case 'rebuilding':
		case 'removing':
			return 0;
		case 'running':
			return 1;
		case 'failed':
			return 2;
		case 'stopped':
		case 'not-created':
		case 'unknown':
			return 3;
		case 'missing-config':
			return 4;
	}
}

export function selectedWorkspace(state: TuiState): TuiWorkspace | null {
	return (
		state.workspaces.find((w) => w.ref.rootPath === state.selectedPath) ?? null
	);
}

export function reduce(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case 'doctor-blocked':
			return { ...state, phase: 'doctor-blocked', doctorReport: action.report };
		case 'retry-loading':
			return {
				...INITIAL_STATE,
				statusMessage: 'Checking your setup again…',
			};
		case 'loaded': {
			const workspaces = orderWorkspaces(action.workspaces);
			return {
				...state,
				phase: 'ready',
				dotfilesRepository:
					action.dotfilesRepository !== undefined
						? action.dotfilesRepository
						: state.dotfilesRepository,
				workspaces,
				selectedPath: workspaces[0]?.ref.rootPath ?? null,
				statusMessage:
					workspaces.length === 0
						? 'No workspaces yet — Bring remembers a project after its first `bring up`.'
						: 'Ready',
			};
		}
		case 'refreshed': {
			const workspaces = orderWorkspaces(
				// A refresh never forgets a same-session failure the snapshot
				// cannot see (the registry has no failure memory).
				action.workspaces.map((w) => {
					const previous = state.workspaces.find(
						(p) => p.ref.rootPath === w.ref.rootPath,
					);
					return previous?.status === 'failed' && w.status !== 'running'
						? { ...w, status: 'failed' as const, problem: previous.problem }
						: w;
				}),
			);
			const stillThere = workspaces.some(
				(w) => w.ref.rootPath === state.selectedPath,
			);
			return {
				...state,
				workspaces,
				dotfilesRepository:
					action.dotfilesRepository !== undefined
						? action.dotfilesRepository
						: state.dotfilesRepository,
				selectedPath: stillThere
					? state.selectedPath
					: (workspaces[0]?.ref.rootPath ?? null),
			};
		}
		case 'move-selection': {
			const index = state.workspaces.findIndex(
				(w) => w.ref.rootPath === state.selectedPath,
			);
			const next = Math.min(
				Math.max(index + action.delta, 0),
				state.workspaces.length - 1,
			);
			return {
				...state,
				selectedPath: state.workspaces[next]?.ref.rootPath ?? null,
			};
		}
		case 'move-section': {
			const index = SECTIONS.indexOf(state.section);
			const next = (index + action.delta + SECTIONS.length) % SECTIONS.length;
			return { ...state, section: SECTIONS[next] as Section };
		}
		case 'focus-pane':
			return { ...state, focusedPane: action.pane };
		case 'open-detail':
			return { ...state, detailOpen: true, focusedPane: 'detail' };
		case 'back':
			return { ...state, detailOpen: false, focusedPane: 'list' };
		case 'open-help':
			return { ...state, modal: { kind: 'help' } };
		case 'open-confirm-remove': {
			const selected = selectedWorkspace(state);
			if (selected === null) {
				return state;
			}
			return {
				...state,
				modal: { kind: 'confirm-remove', workspacePath: selected.ref.rootPath },
			};
		}
		case 'close-modal':
			return { ...state, modal: null };
		case 'operation-started':
			return {
				...state,
				modal: null,
				operation: {
					operation: action.operation,
					workspacePath: action.workspace.ref.rootPath,
					workspaceName: action.workspace.name,
					stages: [],
					lastOutput: '',
					startedAt: Date.now(),
				},
				workspaces: orderWorkspaces(
					state.workspaces.map((w) =>
						w.ref.rootPath === action.workspace.ref.rootPath
							? {
									...w,
									status: BUSY[action.operation] ?? w.status,
									problem: undefined,
								}
							: w,
					),
				),
			};
		case 'operation-stage': {
			if (state.operation === undefined || state.operation === null) {
				return state;
			}
			return {
				...state,
				operation: {
					...state.operation,
					stages: [
						...state.operation.stages,
						{
							seq: state.operation.stages.length,
							stage: action.stage,
							message: action.message,
						},
					],
				},
			};
		}
		case 'operation-output': {
			if (state.operation === null) {
				return state;
			}
			const line = lastSafeLine(action.chunk);
			return line === null
				? state
				: { ...state, operation: { ...state.operation, lastOutput: line } };
		}
		case 'operation-completed': {
			if (state.operation === null) {
				return state;
			}
			const { result } = action;
			const failed = result.outcome !== 'success';
			return {
				...state,
				operation: { ...state.operation, result },
				statusMessage: failed
					? `✗ ${result.message}`
					: `✓ ${result.message} in ${formatDuration(result.durationMs)}`,
				workspaces: state.workspaces.map((w) =>
					w.ref.rootPath === result.workspace && failed
						? { ...w, status: 'failed', problem: result.problem }
						: w,
				),
			};
		}
		case 'dismiss-operation':
			return { ...state, operation: null };
		case 'open-logs':
			return {
				...state,
				logView: {
					workspaceName: action.workspaceName,
					// Raw child output carries ANSI codes and tabs that corrupt
					// Ink's cell math and leave artifacts — sanitize per line.
					lines: action.content
						.replace(/\n$/, '')
						.split('\n')
						.map((line) =>
							stripControlCharacters(
								line.replace(/\t/g, '  ').replace(CSI_SEQUENCE, ''),
							),
						),
					scroll: 0,
				},
			};
		case 'scroll-logs': {
			if (state.logView === null) {
				return state;
			}
			const scroll = Math.min(
				Math.max(state.logView.scroll + action.delta, 0),
				Math.max(state.logView.lines.length - 1, 0),
			);
			return { ...state, logView: { ...state.logView, scroll } };
		}
		case 'close-logs':
			return { ...state, logView: null };
		case 'status-message':
			return { ...state, statusMessage: action.message };
	}
}

/** The trailing non-empty line of a chunk, control characters stripped. */
const CSI_SEQUENCE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
	'g',
);

function lastSafeLine(chunk: string): string | null {
	const lines = chunk
		.split(/\r?\n/)
		.map((line) =>
			stripControlCharacters(line.replace(CSI_SEQUENCE, '')).trim(),
		)
		.filter((line) => line.length > 0);
	return lines.at(-1) ?? null;
}

function stripControlCharacters(line: string): string {
	let out = '';
	for (const ch of line) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 32 && code !== 127) {
			out += ch;
		}
	}
	return out;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

/** §12.1 status symbols — meaning never carried by color alone. */
export function statusSymbol(status: WorkspaceStatus): string {
	switch (status) {
		case 'running':
			return '●';
		case 'stopped':
		case 'not-created':
			return '○';
		case 'starting':
		case 'stopping':
		case 'removing':
			return '◐';
		case 'rebuilding':
			return '◆';
		case 'failed':
		case 'missing-config':
			return '!';
		case 'unknown':
			return '?';
	}
}

export function statusColor(status: WorkspaceStatus): string | undefined {
	switch (status) {
		case 'running':
			return 'green';
		case 'starting':
		case 'stopping':
		case 'rebuilding':
		case 'removing':
			return 'yellow';
		case 'failed':
			return 'red';
		case 'missing-config':
			return 'red';
		default:
			return undefined;
	}
}

/** Human label; also disambiguates statuses sharing a symbol. */
export function statusLabel(status: WorkspaceStatus): string {
	return status === 'not-created' ? 'not created' : status.replace('-', ' ');
}

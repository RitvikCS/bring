import type { DoctorReport } from '../application/doctor.js';
import type { BringProblem } from '../core/errors.js';
import type {
	OperationKind,
	OperationResult,
	OperationStage,
} from '../core/operation-events.js';
import {
	type DevContainerImageResource,
	type DevContainerResource,
	isImageAttached,
	isImagePruneCandidate,
	type ResourceInventory,
} from '../core/resources.js';
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
export type ResourceSection = 'containers' | 'images';
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
	/** Docker's human container age ("Up 2 hours"), when a container exists. */
	uptimeText?: string;
	/** Tail of the latest operation log, sanitized, newest last. */
	logTail?: string[];
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
	| { kind: 'confirm-remove'; workspacePath: string }
	| { kind: 'confirm-rebuild'; workspacePath: string }
	| { kind: 'confirm-container-remove'; containerId: string }
	| { kind: 'confirm-image-remove'; imageIds: string[] };

export interface ResourceOperation {
	kind: 'stop-container' | 'remove-container' | 'remove-images';
	resourceId: string;
	resourceName: string;
}

export interface FilterInputState {
	section: ResourceSection;
	draft: string;
	original: string;
}

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
	containers: DevContainerResource[];
	selectedContainerId: string | null;
	images: DevContainerImageResource[];
	selectedImageId: string | null;
	selectedImageIds: string[];
	resourceProblem: BringProblem | null;
	filters: Record<ResourceSection, string>;
	filterInput: FilterInputState | null;
	/** Wide layout: which pane has focus. Narrow: detail visible or not. */
	focusedPane: 'list' | 'detail';
	detailOpen: boolean;
	modal: Modal | null;
	logView: LogViewState | null;
	operation: OperationProgress | null;
	resourceOperation: ResourceOperation | null;
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
	containers: [],
	selectedContainerId: null,
	images: [],
	selectedImageId: null,
	selectedImageIds: [],
	resourceProblem: null,
	filters: { containers: '', images: '' },
	filterInput: null,
	focusedPane: 'list',
	detailOpen: false,
	modal: null,
	logView: null,
	operation: null,
	resourceOperation: null,
	statusMessage: 'Checking your setup…',
	dotfilesRepository: null,
};

export type TuiAction =
	| { type: 'doctor-blocked'; report: DoctorReport }
	| {
			type: 'loaded';
			workspaces: TuiWorkspace[];
			resources?: ResourceInventory;
			resourceProblem?: BringProblem | null;
			dotfilesRepository?: string | null;
	  }
	| {
			type: 'refreshed';
			workspaces: TuiWorkspace[];
			resources?: ResourceInventory;
			resourceProblem?: BringProblem | null;
			dotfilesRepository?: string | null;
	  }
	| { type: 'retry-loading' }
	| { type: 'move-selection'; delta: 1 | -1 }
	| { type: 'move-section'; delta: 1 | -1 }
	| { type: 'set-section'; section: Section }
	| { type: 'focus-pane'; pane: 'list' | 'detail' }
	| { type: 'open-detail' }
	| { type: 'back' }
	| { type: 'open-help' }
	| { type: 'open-confirm-remove' }
	| { type: 'open-confirm-rebuild' }
	| { type: 'open-confirm-container-remove' }
	| { type: 'toggle-image-selection' }
	| { type: 'select-prunable-images' }
	| { type: 'open-confirm-image-remove' }
	| { type: 'open-filter' }
	| { type: 'filter-input'; text: string }
	| { type: 'filter-backspace' }
	| { type: 'apply-filter' }
	| { type: 'cancel-filter' }
	| { type: 'clear-filter' }
	| { type: 'close-modal' }
	| {
			type: 'resource-operation-started';
			kind: ResourceOperation['kind'];
			resourceId: string;
			resourceName: string;
	  }
	| { type: 'resource-operation-completed'; ok: boolean; message: string }
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

export function selectedContainer(
	state: TuiState,
): DevContainerResource | null {
	return (
		state.containers.find(
			(container) => container.id === state.selectedContainerId,
		) ?? null
	);
}

export function selectedImage(
	state: TuiState,
): DevContainerImageResource | null {
	return (
		state.images.find((image) => image.id === state.selectedImageId) ?? null
	);
}

export function selectedImages(state: TuiState): DevContainerImageResource[] {
	return state.images.filter((image) =>
		state.selectedImageIds.includes(image.id),
	);
}

export function visibleContainers(state: TuiState): DevContainerResource[] {
	const query = state.filters.containers;
	return state.containers.filter((container) =>
		matchesContainer(container, query),
	);
}

export function visibleImages(state: TuiState): DevContainerImageResource[] {
	const query = state.filters.images;
	return state.images.filter((image) => matchesImage(image, query));
}

/** Lowercase queries ignore case; any uppercase letter makes matching exact. */
export function smartMatch(value: string, query: string): boolean {
	if (query === '') {
		return true;
	}
	const caseSensitive = query !== query.toLocaleLowerCase();
	return caseSensitive
		? value.includes(query)
		: value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
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
			const resources = action.resources ?? emptyResources();
			const images = resources.images ?? [];
			return {
				...state,
				phase: 'ready',
				dotfilesRepository:
					action.dotfilesRepository !== undefined
						? action.dotfilesRepository
						: state.dotfilesRepository,
				workspaces,
				selectedPath: workspaces[0]?.ref.rootPath ?? null,
				containers: resources.containers,
				selectedContainerId: resources.containers[0]?.id ?? null,
				images,
				selectedImageId: images[0]?.id ?? null,
				selectedImageIds: [],
				resourceProblem: action.resourceProblem ?? null,
				statusMessage:
					action.resourceProblem !== undefined &&
					action.resourceProblem !== null
						? `! ${action.resourceProblem.summary}`
						: workspaces.length === 0
							? 'No workspaces yet — Bring remembers a project after its first `bring up`.'
							: 'Ready',
			};
		}
		case 'refreshed': {
			const resources = action.resources ?? {
				containers: state.containers,
				images: state.images,
				refreshedAt: '',
			};
			// A pass that skipped image inspection (images: null) must leave the
			// image list AND the user's Space-marks untouched — otherwise a
			// glance at another section silently discards a staged removal batch.
			const images = resources.images ?? state.images;
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
			const visibleContainerResources = resources.containers.filter(
				(container) => matchesContainer(container, state.filters.containers),
			);
			const visibleImageResources = images.filter((image) =>
				matchesImage(image, state.filters.images),
			);
			const containerStillThere = visibleContainerResources.some(
				(container) => container.id === state.selectedContainerId,
			);
			const imageStillThere = visibleImageResources.some(
				(image) => image.id === state.selectedImageId,
			);
			const selectedImageIds = state.selectedImageIds.filter((id) =>
				images.some((image) => image.id === id && !isImageAttached(image)),
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
				containers: resources.containers,
				selectedContainerId: containerStillThere
					? state.selectedContainerId
					: (visibleContainerResources[0]?.id ?? null),
				images,
				selectedImageId: imageStillThere
					? state.selectedImageId
					: (visibleImageResources[0]?.id ?? null),
				selectedImageIds,
				resourceProblem:
					action.resourceProblem !== undefined
						? action.resourceProblem
						: state.resourceProblem,
			};
		}
		case 'move-selection': {
			if (state.section === 'containers') {
				const containers = visibleContainers(state);
				const index = containers.findIndex(
					(container) => container.id === state.selectedContainerId,
				);
				const next = clampedIndex(index, action.delta, containers.length);
				return {
					...state,
					selectedContainerId: containers[next]?.id ?? null,
				};
			}
			if (state.section === 'images') {
				const images = visibleImages(state);
				const index = images.findIndex(
					(image) => image.id === state.selectedImageId,
				);
				const next = clampedIndex(index, action.delta, images.length);
				return {
					...state,
					selectedImageId: images[next]?.id ?? null,
				};
			}
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
			return {
				...state,
				section: SECTIONS[next] as Section,
				focusedPane: 'list',
				detailOpen: false,
				filterInput: null,
			};
		}
		case 'set-section':
			return {
				...state,
				section: action.section,
				focusedPane: 'list',
				detailOpen: false,
				filterInput: null,
			};
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
		case 'open-confirm-rebuild': {
			const selected = selectedWorkspace(state);
			if (selected === null) {
				return state;
			}
			return {
				...state,
				modal: {
					kind: 'confirm-rebuild',
					workspacePath: selected.ref.rootPath,
				},
			};
		}
		case 'open-confirm-container-remove': {
			const selected = selectedContainer(state);
			if (selected === null) {
				return state;
			}
			return {
				...state,
				modal: {
					kind: 'confirm-container-remove',
					containerId: selected.id,
				},
			};
		}
		case 'toggle-image-selection': {
			const image = selectedImage(state);
			if (image === null) {
				return state;
			}
			if (isImageAttached(image)) {
				return {
					...state,
					statusMessage: `${image.displayName} is in use by ${image.containerNames.join(', ')} and cannot be selected.`,
				};
			}
			const selected = state.selectedImageIds.includes(image.id);
			return {
				...state,
				selectedImageIds: selected
					? state.selectedImageIds.filter((id) => id !== image.id)
					: [...state.selectedImageIds, image.id],
				statusMessage:
					!selected && image.usage === 'base'
						? `${image.displayName} is a cached base for ${image.descendantContainerNames.join(', ')}; removing it may slow a future rebuild.`
						: state.statusMessage,
			};
		}
		case 'select-prunable-images': {
			const selectedImageIds = state.images
				.filter(isImagePruneCandidate)
				.map((image) => image.id);
			return {
				...state,
				selectedImageIds,
				statusMessage:
					selectedImageIds.length === 0
						? 'No safely prunable dangling Dev Container images.'
						: `Selected ${selectedImageIds.length} dangling image${selectedImageIds.length === 1 ? '' : 's'} for review.`,
			};
		}
		case 'open-confirm-image-remove': {
			const current = selectedImage(state);
			const imageIds =
				state.selectedImageIds.length > 0
					? state.selectedImageIds
					: current === null
						? []
						: [current.id];
			const images = state.images.filter((image) =>
				imageIds.includes(image.id),
			);
			const blocked = images.find(isImageAttached);
			if (blocked !== undefined) {
				return {
					...state,
					statusMessage: `${blocked.displayName} is in use and cannot be removed.`,
				};
			}
			if (images.length === 0) {
				return { ...state, statusMessage: 'No removable images selected.' };
			}
			return {
				...state,
				modal: { kind: 'confirm-image-remove', imageIds },
			};
		}
		case 'open-filter': {
			if (state.section !== 'containers' && state.section !== 'images') {
				return state;
			}
			const query = state.filters[state.section];
			return {
				...state,
				filterInput: {
					section: state.section,
					draft: query,
					original: query,
				},
			};
		}
		case 'filter-input':
			return state.filterInput === null
				? state
				: updateFilter(state, `${state.filterInput.draft}${action.text}`);
		case 'filter-backspace':
			return state.filterInput === null
				? state
				: updateFilter(
						state,
						[...state.filterInput.draft].slice(0, -1).join(''),
					);
		case 'apply-filter':
			return { ...state, filterInput: null };
		case 'cancel-filter':
			return state.filterInput === null
				? state
				: finishFilter(state, state.filterInput.original);
		case 'clear-filter':
			return state.section === 'containers' || state.section === 'images'
				? finishFilter(state, '')
				: state;
		case 'close-modal':
			return { ...state, modal: null };
		case 'resource-operation-started':
			return {
				...state,
				modal: null,
				resourceOperation: {
					kind: action.kind,
					resourceId: action.resourceId,
					resourceName: action.resourceName,
				},
				statusMessage: `${
					action.kind === 'stop-container' ? 'Stopping' : 'Removing'
				} ${action.resourceName}…`,
			};
		case 'resource-operation-completed':
			return {
				...state,
				resourceOperation: null,
				selectedImageIds:
					state.resourceOperation?.kind === 'remove-images' && action.ok
						? []
						: state.selectedImageIds,
				statusMessage: `${action.ok ? '✓' : '✗'} ${action.message}`,
			};
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
						.map(sanitizeLogLine),
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

function updateFilter(state: TuiState, draft: string): TuiState {
	const input = state.filterInput;
	if (input === null) {
		return state;
	}
	const filters = { ...state.filters, [input.section]: draft };
	const next = {
		...state,
		filters,
		filterInput: { ...input, draft },
	};
	if (input.section === 'containers') {
		const visible = visibleContainers(next);
		return {
			...next,
			selectedContainerId: visible.some(
				(container) => container.id === state.selectedContainerId,
			)
				? state.selectedContainerId
				: (visible[0]?.id ?? null),
		};
	}
	const visible = visibleImages(next);
	return {
		...next,
		selectedImageId: visible.some((image) => image.id === state.selectedImageId)
			? state.selectedImageId
			: (visible[0]?.id ?? null),
	};
}

function finishFilter(state: TuiState, query: string): TuiState {
	let updated = state;
	if (updated.filterInput === null) {
		if (updated.section !== 'containers' && updated.section !== 'images') {
			return state;
		}
		updated = {
			...updated,
			filterInput: {
				section: updated.section,
				draft: updated.filters[updated.section],
				original: updated.filters[updated.section],
			},
		};
	}
	return { ...updateFilter(updated, query), filterInput: null };
}

function matchesContainer(
	container: DevContainerResource,
	query: string,
): boolean {
	return smartMatch(
		[
			container.name,
			container.workspaceName,
			container.statusText,
			container.imageName,
			container.serviceName ?? '',
		].join(' '),
		query,
	);
}

function matchesImage(
	image: DevContainerImageResource,
	query: string,
): boolean {
	return smartMatch(
		[
			image.displayName,
			...image.references,
			...image.containerNames,
			...image.workspaceNames,
			image.usage === 'attached'
				? 'attached in use'
				: image.usage === 'base'
					? 'base cached ancestor'
					: image.dangling
						? 'dangling'
						: 'unused tagged',
		].join(' '),
		query,
	);
}

function emptyResources(): ResourceInventory {
	return { containers: [], images: [], refreshedAt: '' };
}

function clampedIndex(index: number, delta: 1 | -1, length: number): number {
	return Math.min(Math.max(index + delta, 0), length - 1);
}

/** The trailing non-empty line of a chunk, control characters stripped. */
const CSI_SEQUENCE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
	'g',
);

/** One log line made safe for a terminal cell grid: no ANSI, tabs, or C0s. */
export function sanitizeLogLine(line: string): string {
	return stripControlCharacters(
		line.replace(/\t/g, '  ').replace(CSI_SEQUENCE, ''),
	);
}

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

/** "3 minutes ago"-style rendering of an ISO timestamp; null if unusable. */
export function relativeTime(iso: string, nowMs: number): string | null {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return null;
	}
	const seconds = Math.max(Math.round((nowMs - then) / 1000), 0);
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 30) {
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}
	return new Date(then).toISOString().slice(0, 10);
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

import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useReducer,
	useRef,
} from 'react';
import type {
	OperationKind,
	OperationResult,
} from '../core/operation-events.js';
import { isImagePruneCandidate } from '../core/resources.js';
import { Spinner } from '../direct/Spinner.js';
import { enteringShellLine } from '../direct/shell-banner.js';
import { ContainerDetail, ContainerList } from './ContainersPane.js';
import { DoctorBlocked } from './DoctorBlocked.js';
import { ImageDetail, ImageList } from './ImagesPane.js';
import { keyToCommand, type TuiCommand } from './keymap.js';
import { LogView } from './LogView.js';
import {
	contentRows,
	layoutMode,
	listPaneWidth,
	logVisibleRows,
	MIN_COLUMNS,
	MIN_ROWS,
	resourceListPaneWidth,
	type Size,
} from './layout.js';
import type { TuiEnvironment } from './load.js';
import {
	ConfirmContainerRemove,
	ConfirmImageRemove,
	ConfirmRebuild,
	ConfirmRemove,
	HelpOverlay,
} from './modals.js';
import { OperationView } from './OperationView.js';
import {
	INITIAL_STATE,
	reduce,
	SECTIONS,
	type Section,
	selectedContainer,
	selectedImage,
	type selectedImages,
	selectedWorkspace,
	type TuiState,
	type TuiWorkspace,
	visibleContainers,
	visibleImages,
} from './state.js';
import { handTerminalToChild } from './stdin-gate.js';
import { WorkspaceDetail, WorkspaceList } from './WorkspacesPane.js';

// The Workspaces TUI shell (P1-33…P1-43, spec §11): state lives in the pure
// reducer, keys go through the pure keymap, and this file is the only place
// commands become effects (operations, the shell, log reads, exit).

export interface AppProps {
	environment: TuiEnvironment;
	version: string;
	initialSection?: Section;
	/** Pinned size for tests; real runs track the terminal. */
	sizeOverride?: Size;
}

export function App({
	environment,
	version,
	initialSection,
	sizeOverride,
}: AppProps) {
	const { exit, suspendTerminal } = useApp();
	const windowSize = useWindowSize();
	// Reserve the terminal's last column: when a floating window's width is
	// not an exact multiple of the cell width, some terminals (ghostty)
	// leave a partial final column that never renders — drawing into it
	// made the frame's right border invisible at those sizes.
	const size = sizeOverride ?? {
		columns: Math.max(windowSize.columns - 1, 1),
		rows: windowSize.rows,
	};
	const [state, dispatch] = useReducer(reduce, {
		...INITIAL_STATE,
		section: initialSection ?? 'workspaces',
	});
	// Effects read the latest state without re-subscribing useInput.
	const stateRef = useRef(state);
	stateRef.current = state;
	// Keys are ignored until this timestamp — set after a shell returns, so
	// an `exit⏎` typed into an already-dead shell can't leak into the TUI as
	// commands (e = shell, x = remove request, Enter = confirm…).
	const ignoreInputUntilRef = useRef(0);
	// When a confirmation modal opened — it ignores Enter for its first
	// moments so a buffered keypress can never insta-confirm a destructive
	// action the user hasn't even seen yet.
	const modalOpenedAtRef = useRef(0);
	// Polling and post-operation refreshes may coincide. One inventory query at
	// a time prevents Docker inspect processes from piling up behind the TUI —
	// but a request arriving mid-flight is QUEUED, never dropped: the in-flight
	// data was snapshotted before the mutation that requested the new pass.
	const refreshingRef = useRef(false);
	// undefined = nothing queued; null = queued for the then-current section.
	const queuedRefreshRef = useRef<Section | null | undefined>(undefined);

	// Repaint from scratch shortly after the terminal is resized. Incremental
	// rendering diffs against the previous frame, but a resize invalidates
	// what is actually on screen (stale cells, shifted rows); an empty
	// suspend cycle is Ink's sanctioned full redraw. Debounced so a drag
	// resize causes one repaint, not dozens.
	const firstSizeRef = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: size.columns/size.rows are triggers — the effect must re-run on resize without reading the values.
	useEffect(() => {
		if (sizeOverride !== undefined) {
			return;
		}
		if (firstSizeRef.current) {
			firstSizeRef.current = false;
			return;
		}
		const timer = setTimeout(() => {
			void (async () => {
				try {
					await suspendTerminal(async () => {});
				} catch {
					// A real suspension (the shell) is active — it repaints anyway.
				}
			})();
		}, 200);
		return () => clearTimeout(timer);
	}, [size.columns, size.rows, suspendTerminal, sizeOverride]);

	const refresh = useCallback(
		async (sectionOverride?: Section) => {
			if (refreshingRef.current) {
				queuedRefreshRef.current = sectionOverride ?? null;
				return;
			}
			refreshingRef.current = true;
			try {
				let requested = sectionOverride;
				for (;;) {
					const section = requested ?? stateRef.current.section;
					const data = await environment.load({
						includeImages: section === 'images',
					});
					dispatch({
						type: 'refreshed',
						workspaces: data.workspaces,
						resources: data.resources,
						resourceProblem: data.resourceProblem,
						dotfilesRepository: data.dotfilesRepository,
					});
					if (queuedRefreshRef.current === undefined) {
						return;
					}
					requested = queuedRefreshRef.current ?? undefined;
					queuedRefreshRef.current = undefined;
				}
			} finally {
				refreshingRef.current = false;
			}
		},
		[environment],
	);

	// Loading phase (§11.5): doctor gates everything (P1-43).
	useEffect(() => {
		if (state.phase !== 'loading') {
			return;
		}
		let cancelled = false;
		void (async () => {
			const report = await environment.doctor();
			if (cancelled) {
				return;
			}
			if (!report.healthy) {
				dispatch({ type: 'doctor-blocked', report });
				return;
			}
			const data = await environment.load({
				includeImages: state.section === 'images',
			});
			if (!cancelled) {
				dispatch({
					type: 'loaded',
					workspaces: data.workspaces,
					resources: data.resources,
					resourceProblem: data.resourceProblem,
					dotfilesRepository: data.dotfilesRepository,
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [state.phase, state.section, environment]);

	// The world changes underneath the TUI (a `bring down` in another
	// terminal, a container dying) — poll while idle so the list stays
	// truthful. Skipped whenever an operation, modal, or log view is open.
	useEffect(() => {
		if (state.phase !== 'ready') {
			return;
		}
		const timer = setInterval(() => {
			const current = stateRef.current;
			if (
				current.operation === null &&
				current.resourceOperation === null &&
				current.modal === null &&
				current.logView === null
			) {
				void refresh();
			}
		}, 3000);
		return () => clearInterval(timer);
	}, [state.phase, refresh]);

	const runMutation = useCallback(
		(kind: OperationKind, workspace: TuiWorkspace) => {
			dispatch({ type: 'operation-started', operation: kind, workspace });
			const operation =
				kind === 'up' || kind === 'rebuild'
					? environment.up(
							workspace.ref,
							{ rebuild: kind === 'rebuild' },
							(event) => {
								if (event.type === 'stage') {
									dispatch({
										type: 'operation-stage',
										stage: event.stage,
										message: event.message,
									});
								}
								if (event.type === 'output') {
									dispatch({ type: 'operation-output', chunk: event.chunk });
								}
							},
						)
					: environment.down(
							workspace.ref,
							{ remove: kind === 'remove' },
							(event) => {
								if (event.type === 'stage') {
									dispatch({
										type: 'operation-stage',
										stage: event.stage,
										message: event.message,
									});
								}
							},
						);
			void operation
				.catch(
					(error): OperationResult => ({
						operation: kind,
						outcome: 'failed',
						workspace: workspace.ref.rootPath,
						workspaceName: workspace.name,
						message: error instanceof Error ? error.message : String(error),
						durationMs: 0,
						containerIds: [],
					}),
				)
				.then(async (result) => {
					dispatch({ type: 'operation-completed', result });
					await refresh();
				});
		},
		[environment, refresh],
	);

	const runContainerMutation = useCallback(
		(
			kind: 'stop' | 'remove',
			container: ReturnType<typeof selectedContainer>,
		) => {
			if (container === null) {
				return;
			}
			dispatch({
				type: 'resource-operation-started',
				kind: kind === 'stop' ? 'stop-container' : 'remove-container',
				resourceId: container.id,
				resourceName: container.name,
			});
			void environment
				.mutateContainer(container, kind)
				.catch((error) => ({
					ok: false as const,
					message: error instanceof Error ? error.message : String(error),
					problem: {
						code: 'INTERNAL_ERROR' as const,
						summary: error instanceof Error ? error.message : String(error),
					},
				}))
				.then(async (result) => {
					dispatch({
						type: 'resource-operation-completed',
						ok: result.ok,
						message: result.message,
					});
					await refresh('containers');
				});
		},
		[environment, refresh],
	);

	const runImageRemoval = useCallback(
		(images: ReturnType<typeof selectedImages>) => {
			if (images.length === 0) {
				return;
			}
			dispatch({
				type: 'resource-operation-started',
				kind: 'remove-images',
				resourceId: images.map((image) => image.id).join(','),
				resourceName: `${images.length} image${images.length === 1 ? '' : 's'}`,
			});
			void environment
				.removeImages(images)
				.catch((error) => ({
					ok: false as const,
					message: error instanceof Error ? error.message : String(error),
					problem: {
						code: 'INTERNAL_ERROR' as const,
						summary: error instanceof Error ? error.message : String(error),
					},
				}))
				.then(async (result) => {
					dispatch({
						type: 'resource-operation-completed',
						ok: result.ok,
						message: result.message,
					});
					await refresh('images');
				});
		},
		[environment, refresh],
	);

	const runShell = useCallback(
		async (workspace: TuiWorkspace) => {
			// P1-42: the shell owns the terminal until it exits; Ink restores
			// the alternate screen and repaints when the suspension ends.
			await suspendTerminal(async () => {
				const reclaimStdin = handTerminalToChild();
				try {
					process.stdout.write(`${enteringShellLine(workspace.name, true)}\n`);
					await environment.shell(workspace.ref);
				} finally {
					reclaimStdin();
				}
			});
			// Anything typed into the dying/dead shell would otherwise arrive
			// here as TUI commands the instant input resumes.
			ignoreInputUntilRef.current = Date.now() + 400;
			dispatch({
				type: 'status-message',
				message: `Shell in ${workspace.name} closed — back in Bring.`,
			});
			await refresh();
		},
		[environment, refresh, suspendTerminal],
	);

	const runContainerShell = useCallback(
		async (container: NonNullable<ReturnType<typeof selectedContainer>>) => {
			let resultMessage = `Shell in ${container.name} closed — back in Bring.`;
			await suspendTerminal(async () => {
				const reclaimStdin = handTerminalToChild();
				try {
					process.stdout.write(`${enteringShellLine(container.name, true)}\n`);
					const result = await environment.containerShell(container);
					if (!result.ok) {
						resultMessage = result.message;
					}
				} finally {
					reclaimStdin();
				}
			});
			ignoreInputUntilRef.current = Date.now() + 400;
			dispatch({
				type: 'status-message',
				message: resultMessage,
			});
			await refresh('containers');
		},
		[environment, refresh, suspendTerminal],
	);

	const openLogs = useCallback(
		(workspace: TuiWorkspace) => {
			const content = environment.readLog(workspace.ref);
			if (content === null) {
				dispatch({
					type: 'status-message',
					message: `No log for ${workspace.name} yet — logs appear after the first up.`,
				});
				return;
			}
			dispatch({ type: 'open-logs', workspaceName: workspace.name, content });
		},
		[environment],
	);

	const execute = useCallback(
		(command: TuiCommand) => {
			const current = stateRef.current;
			const wide = layoutMode(size) === 'wide';
			const selected = selectedWorkspace(current);
			const container = selectedContainer(current);
			const operationRunning =
				(current.operation !== null &&
					current.operation.result === undefined) ||
				current.resourceOperation !== null;
			const busy = (workspace: TuiWorkspace | null) =>
				workspace !== null &&
				['starting', 'stopping', 'rebuilding', 'removing'].includes(
					workspace.status,
				);

			switch (command.kind) {
				case 'quit':
					if (operationRunning) {
						dispatch({
							type: 'status-message',
							message: `Wait for ${
								current.operation?.operation ??
								current.resourceOperation?.kind.replace('-', ' ')
							} to finish (Ctrl+C aborts Bring).`,
						});
						return;
					}
					exit();
					return;
				case 'retry-doctor':
					dispatch({ type: 'retry-loading' });
					return;
				case 'move-selection':
					dispatch({ type: 'move-selection', delta: command.delta });
					return;
				case 'move-section': {
					const index = SECTIONS.indexOf(current.section);
					const next =
						SECTIONS[
							(index + command.delta + SECTIONS.length) % SECTIONS.length
						] ?? 'workspaces';
					dispatch({ type: 'move-section', delta: command.delta });
					void refresh(next);
					return;
				}
				case 'jump-section': {
					const section = SECTIONS[command.index];
					if (section === undefined) {
						return;
					}
					dispatch({ type: 'set-section', section });
					void refresh(section);
					return;
				}
				case 'focus-next': {
					const pane = current.focusedPane === 'list' ? 'detail' : 'list';
					if (wide) {
						dispatch({ type: 'focus-pane', pane });
					} else if (current.detailOpen) {
						dispatch({ type: 'back' });
					} else {
						dispatch({ type: 'open-detail' });
					}
					return;
				}
				case 'focus-pane':
					if (wide) {
						dispatch({ type: 'focus-pane', pane: command.pane });
					} else if (command.pane === 'detail') {
						dispatch({ type: 'open-detail' });
					} else {
						dispatch({ type: 'back' });
					}
					return;
				case 'primary':
					if (current.section === 'containers') {
						if (selectedContainer(current) !== null) {
							dispatch({ type: 'open-detail' });
						}
						return;
					}
					if (current.section === 'images') {
						if (selectedImage(current) !== null) {
							dispatch({ type: 'open-detail' });
						}
						return;
					}
					if (selected === null || current.section !== 'workspaces') {
						return;
					}
					// Narrow: Enter goes to detail (§11.4). Wide: the §12.1
					// primary-action table.
					if (!wide && !current.detailOpen) {
						dispatch({ type: 'open-detail' });
						return;
					}
					if (busy(selected)) {
						return;
					}
					if (
						selected.status === 'stopped' ||
						selected.status === 'not-created'
					) {
						runMutation('up', selected);
					} else {
						dispatch({ type: 'open-detail' });
					}
					return;
				case 'back':
					if (current.logView !== null) {
						dispatch({ type: 'close-logs' });
					} else {
						dispatch({ type: 'back' });
					}
					return;
				case 'open-help':
					dispatch({ type: 'open-help' });
					return;
				case 'close-modal':
					dispatch({ type: 'close-modal' });
					return;
				case 'workspace-up':
					// The keymap already scopes `u` to Workspaces; this guard keeps
					// a future keymap change from ever mutating a hidden selection.
					if (current.section !== 'workspaces') {
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					if (selected.status === 'missing-config') {
						dispatch({
							type: 'status-message',
							message: `${selected.name} has no configuration to bring up.`,
						});
						return;
					}
					if (selected.status === 'running') {
						dispatch({
							type: 'status-message',
							message: `${selected.name} is already running.`,
						});
						return;
					}
					runMutation('up', selected);
					return;
				case 'workspace-down':
					if (current.section === 'containers') {
						if (container !== null) {
							runContainerMutation('stop', container);
						}
						return;
					}
					if (current.section !== 'workspaces') {
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					runMutation('down', selected);
					return;
				case 'rebuild-or-refresh':
					if (current.section !== 'workspaces') {
						void refresh().then(() =>
							dispatch({
								type: 'status-message',
								message: 'Resources refreshed.',
							}),
						);
						return;
					}
					if (selected !== null && selected.status === 'missing-config') {
						void refresh().then(() =>
							dispatch({ type: 'status-message', message: 'Checked again.' }),
						);
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					// Rebuild deletes the container and rebuilds from scratch —
					// too expensive for a stray keystroke, so it confirms first.
					modalOpenedAtRef.current = Date.now();
					dispatch({ type: 'open-confirm-rebuild' });
					return;
				case 'open-shell':
					if (current.section === 'containers') {
						if (container === null) {
							return;
						}
						if (container.state !== 'running') {
							dispatch({
								type: 'status-message',
								message: `${container.name} is not running.`,
							});
							return;
						}
						void runContainerShell(container);
						return;
					}
					if (current.section !== 'workspaces') {
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					if (selected.status !== 'running') {
						dispatch({
							type: 'status-message',
							message: `${selected.name} is not running — press u first.`,
						});
						return;
					}
					void runShell(selected);
					return;
				case 'open-logs': {
					// Reachable outside Workspaces only from the operation pane,
					// where the operation names the log's workspace explicitly.
					if (current.operation === null && current.section !== 'workspaces') {
						return;
					}
					const target =
						current.operation !== null
							? (current.workspaces.find(
									(w) => w.ref.rootPath === current.operation?.workspacePath,
								) ?? selected)
							: selected;
					if (target !== null) {
						openLogs(target);
					}
					return;
				}
				case 'request-remove':
					if (current.section === 'containers') {
						if (container !== null) {
							modalOpenedAtRef.current = Date.now();
							dispatch({ type: 'open-confirm-container-remove' });
						}
						return;
					}
					if (current.section === 'images') {
						modalOpenedAtRef.current = Date.now();
						dispatch({ type: 'open-confirm-image-remove' });
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					if (selected.status === 'missing-config') {
						dispatch({
							type: 'status-message',
							message: `${selected.name} has nothing to remove.`,
						});
						return;
					}
					modalOpenedAtRef.current = Date.now();
					dispatch({ type: 'open-confirm-remove' });
					return;
				case 'confirm-modal': {
					const modal = current.modal;
					if (
						modal?.kind !== 'confirm-remove' &&
						modal?.kind !== 'confirm-rebuild' &&
						modal?.kind !== 'confirm-container-remove' &&
						modal?.kind !== 'confirm-image-remove'
					) {
						return;
					}
					// A confirmation must be a deliberate second keystroke: an
					// Enter arriving within the modal's first instants is
					// buffered/typed-ahead input, not a decision.
					if (Date.now() - modalOpenedAtRef.current < 300) {
						return;
					}
					if (modal.kind === 'confirm-container-remove') {
						const target = current.containers.find(
							(item) => item.id === modal.containerId,
						);
						dispatch({ type: 'close-modal' });
						if (target !== undefined) {
							runContainerMutation('remove', target);
						}
						return;
					}
					if (modal.kind === 'confirm-image-remove') {
						const targets = current.images.filter((image) =>
							modal.imageIds.includes(image.id),
						);
						dispatch({ type: 'close-modal' });
						runImageRemoval(targets);
						return;
					}
					const target = current.workspaces.find(
						(w) => w.ref.rootPath === modal.workspacePath,
					);
					dispatch({ type: 'close-modal' });
					if (target !== undefined) {
						runMutation(
							modal.kind === 'confirm-remove' ? 'remove' : 'rebuild',
							target,
						);
					}
					return;
				}
				case 'scroll-logs': {
					if (current.logView === null) {
						return;
					}
					// g/G arrive as huge deltas; translate to a real target so
					// the reducer's clamp lands exactly on the last page.
					const visible = logVisibleRows(size);
					const maxStart = Math.max(current.logView.lines.length - visible, 0);
					const target = Math.min(
						Math.max(current.logView.scroll + command.delta, 0),
						maxStart,
					);
					dispatch({
						type: 'scroll-logs',
						delta: target - current.logView.scroll,
					});
					return;
				}
				case 'dismiss-operation':
					dispatch({ type: 'dismiss-operation' });
					void refresh();
					return;
				case 'toggle-selection':
					if (current.section === 'images') {
						dispatch({ type: 'toggle-image-selection' });
					}
					return;
				case 'prune-dangling':
					if (current.section === 'images') {
						dispatch({ type: 'select-prunable-images' });
						modalOpenedAtRef.current = Date.now();
						const prunable = current.images.filter(isImagePruneCandidate);
						if (prunable.length > 0) {
							dispatch({ type: 'open-confirm-image-remove' });
						}
					}
					return;
				case 'open-filter':
					dispatch({ type: 'open-filter' });
					return;
				case 'filter-input':
					dispatch({ type: 'filter-input', text: command.text });
					return;
				case 'filter-backspace':
					dispatch({ type: 'filter-backspace' });
					return;
				case 'apply-filter':
					dispatch({ type: 'apply-filter' });
					return;
				case 'cancel-filter':
					dispatch({ type: 'cancel-filter' });
					return;
				case 'clear-filter':
					dispatch({ type: 'clear-filter' });
					return;
			}
		},
		[
			exit,
			size,
			runMutation,
			runContainerMutation,
			runImageRemoval,
			runShell,
			runContainerShell,
			openLogs,
			refresh,
		],
	);

	useInput((input, key) => {
		if (Date.now() < ignoreInputUntilRef.current) {
			return;
		}
		const current = stateRef.current;
		const command = keyToCommand(input, key, {
			phase: current.phase,
			section: current.section,
			modal: current.modal?.kind ?? null,
			logViewOpen: current.logView !== null,
			operationRunning:
				(current.operation !== null &&
					current.operation.result === undefined) ||
				current.resourceOperation !== null,
			operationSettled: current.operation?.result !== undefined,
			filtering: current.filterInput !== null,
			filterActive:
				(current.section === 'containers' || current.section === 'images') &&
				current.filters[current.section] !== '',
			detailOpen: current.detailOpen,
		});
		if (command !== null) {
			execute(command);
		}
	});

	return <AppView state={state} size={size} version={version} />;
}

/** Pure view over the TUI state — render tests pin `size` and go. */
export function AppView({
	state,
	size,
	version,
}: {
	state: TuiState;
	size: Size;
	version: string;
}) {
	const mode = layoutMode(size);
	if (mode === 'too-small') {
		return (
			<Box flexDirection="column" padding={1}>
				<Text>
					Bring needs at least {MIN_COLUMNS} columns × {MIN_ROWS} rows for the
					full TUI.
				</Text>
				<Text>
					Resize the terminal or use a direct command such as `bring . up`.
				</Text>
			</Box>
		);
	}
	if (state.phase === 'loading') {
		return (
			<Box flexDirection="column" padding={1}>
				<Text>
					<Spinner /> {state.statusMessage}
				</Text>
			</Box>
		);
	}
	if (state.phase === 'doctor-blocked') {
		return state.doctorReport === null ? null : (
			<DoctorBlocked report={state.doctorReport} />
		);
	}
	return (
		<Box flexDirection="column" height={size.rows} width={size.columns}>
			<Header section={state.section} version={version} />
			<Content state={state} size={size} />
			<StatusBar state={state} size={size} />
		</Box>
	);
}

function Header({ section, version }: { section: Section; version: string }) {
	return (
		<Box paddingX={1} gap={2}>
			<Text bold>bring</Text>
			{SECTIONS.map((name, index) => (
				<Text
					key={name}
					inverse={name === section}
					dimColor={name !== section && index > 0}
				>
					{' '}
					{index + 1} {name[0]?.toUpperCase()}
					{name.slice(1)}{' '}
				</Text>
			))}
			<Text dimColor>{version}</Text>
		</Box>
	);
}

function Content({ state, size }: { state: TuiState; size: Size }) {
	const mode = layoutMode(size);
	const rows = contentRows(size);

	if (state.modal?.kind === 'help') {
		return (
			<Box flexGrow={1} justifyContent="center" alignItems="center">
				<HelpOverlay />
			</Box>
		);
	}
	const modal = state.modal;
	if (modal?.kind === 'confirm-container-remove') {
		const target = state.containers.find(
			(container) => container.id === modal.containerId,
		);
		return target === undefined ? null : (
			<Box flexGrow={1} justifyContent="center" alignItems="center">
				<ConfirmContainerRemove container={target} />
			</Box>
		);
	}
	if (modal?.kind === 'confirm-image-remove') {
		const targets = state.images.filter((image) =>
			modal.imageIds.includes(image.id),
		);
		return targets.length === 0 ? null : (
			<Box flexGrow={1} justifyContent="center" alignItems="center">
				<ConfirmImageRemove images={targets} />
			</Box>
		);
	}
	if (modal?.kind === 'confirm-remove' || modal?.kind === 'confirm-rebuild') {
		const target = state.workspaces.find(
			(w) => w.ref.rootPath === modal.workspacePath,
		);
		return target === undefined ? null : (
			<Box flexGrow={1} justifyContent="center" alignItems="center">
				{modal.kind === 'confirm-remove' ? (
					<ConfirmRemove workspace={target} />
				) : (
					<ConfirmRebuild workspace={target} />
				)}
			</Box>
		);
	}
	if (state.logView !== null) {
		return (
			<Pane focused grow>
				<LogView log={state.logView} visibleRows={logVisibleRows(size)} />
			</Pane>
		);
	}
	if (state.section !== 'workspaces') {
		if (state.section === 'containers') {
			return <ContainersContent state={state} size={size} />;
		}
		if (state.section === 'images') {
			return <ImagesContent state={state} size={size} />;
		}
		return (
			<Pane focused grow>
				<Box flexGrow={1} justifyContent="center" alignItems="center">
					<Text dimColor>
						{sectionTitle(state.section)} arrives in a later phase — Workspaces
						is where Phase 1 lives. (h/l to go back)
					</Text>
				</Box>
			</Pane>
		);
	}

	const selected = selectedWorkspace(state);
	const rightPane =
		state.operation !== null ? (
			<OperationView progress={state.operation} />
		) : (
			<WorkspaceDetail
				workspace={selected}
				dotfilesRepository={state.dotfilesRepository}
			/>
		);

	if (mode === 'narrow') {
		const showDetail = state.detailOpen || state.operation !== null;
		return (
			<Pane focused grow>
				{showDetail ? (
					rightPane
				) : (
					<WorkspaceList
						workspaces={state.workspaces}
						selectedPath={state.selectedPath}
						focused
						visibleRows={rows}
					/>
				)}
			</Pane>
		);
	}
	return (
		<Box flexGrow={1} flexDirection="row">
			<Pane focused={state.focusedPane === 'list'} width={listPaneWidth(size)}>
				<WorkspaceList
					workspaces={state.workspaces}
					selectedPath={state.selectedPath}
					focused={state.focusedPane === 'list'}
					visibleRows={rows}
				/>
			</Pane>
			<Pane focused={state.focusedPane === 'detail'} grow>
				{rightPane}
			</Pane>
		</Box>
	);
}

function ImagesContent({ state, size }: { state: TuiState; size: Size }) {
	const mode = layoutMode(size);
	const rows = contentRows(size);
	const image = selectedImage(state);
	const images = visibleImages(state);
	const detail = (
		<ImageDetail
			image={image}
			marked={image !== null && state.selectedImageIds.includes(image.id)}
		/>
	);
	if (mode === 'narrow') {
		return (
			<Pane focused grow>
				{state.detailOpen ? (
					detail
				) : (
					<ImageList
						images={images}
						totalCount={state.images.length}
						filterQuery={state.filters.images}
						selectedId={state.selectedImageId}
						markedIds={state.selectedImageIds}
						focused
						visibleRows={rows}
					/>
				)}
			</Pane>
		);
	}
	return (
		<Box flexGrow={1} flexDirection="row">
			<Pane
				focused={state.focusedPane === 'list'}
				width={resourceListPaneWidth(size)}
			>
				<ImageList
					images={images}
					totalCount={state.images.length}
					filterQuery={state.filters.images}
					selectedId={state.selectedImageId}
					markedIds={state.selectedImageIds}
					focused={state.focusedPane === 'list'}
					visibleRows={rows}
				/>
			</Pane>
			<Pane focused={state.focusedPane === 'detail'} grow>
				{detail}
			</Pane>
		</Box>
	);
}

function ContainersContent({ state, size }: { state: TuiState; size: Size }) {
	const mode = layoutMode(size);
	const rows = contentRows(size);
	const selected = selectedContainer(state);
	const containers = visibleContainers(state);
	if (mode === 'narrow') {
		return (
			<Pane focused grow>
				{state.detailOpen ? (
					<ContainerDetail container={selected} />
				) : (
					<ContainerList
						containers={containers}
						totalCount={state.containers.length}
						filterQuery={state.filters.containers}
						selectedId={state.selectedContainerId}
						focused
						visibleRows={rows}
					/>
				)}
			</Pane>
		);
	}
	return (
		<Box flexGrow={1} flexDirection="row">
			<Pane
				focused={state.focusedPane === 'list'}
				width={resourceListPaneWidth(size)}
			>
				<ContainerList
					containers={containers}
					totalCount={state.containers.length}
					filterQuery={state.filters.containers}
					selectedId={state.selectedContainerId}
					focused={state.focusedPane === 'list'}
					visibleRows={rows}
				/>
			</Pane>
			<Pane focused={state.focusedPane === 'detail'} grow>
				<ContainerDetail container={selected} />
			</Pane>
		</Box>
	);
}

function Pane({
	children,
	focused,
	width,
	grow,
}: {
	children: ReactNode;
	focused: boolean;
	width?: number;
	grow?: boolean;
}) {
	return (
		<Box
			borderStyle="round"
			// Unfocused borders dim the DEFAULT foreground rather than using
			// "gray": ANSI bright-black is invisible on dark/transparent
			// themes (user report — the pane looked like it had no border).
			borderColor={focused ? 'cyan' : undefined}
			borderDimColor={!focused}
			paddingX={1}
			flexDirection="column"
			width={width}
			// A fixed-width pane must never be squeezed by long content in
			// its sibling — that reads as the layout jumping between states.
			flexShrink={width !== undefined ? 0 : undefined}
			flexGrow={grow === true ? 1 : undefined}
		>
			{children}
		</Box>
	);
}

function StatusBar({ state, size }: { state: TuiState; size: Size }) {
	const hints: readonly (readonly [string, string])[] =
		state.filterInput !== null
			? [
					['Enter', 'apply'],
					['Esc', 'cancel'],
				]
			: state.logView !== null
				? [
						['j/k', 'scroll'],
						['Esc', 'back'],
					]
				: state.modal !== null
					? [['Esc', 'close']]
					: state.section === 'containers' || state.section === 'images'
						? [
								['j/k', 'select'],
								['⏎', 'inspect'],
								['/', 'filter'],
								['?', 'help'],
								['q', 'quit'],
							]
						: [
								['h/l', 'tabs'],
								['j/k', 'select'],
								['⏎', 'action'],
								['?', 'help'],
								['q', 'quit'],
							];
	const hintsWidth = hints.reduce(
		(n, [k, l]) => n + k.length + l.length + 4,
		0,
	);
	const message =
		state.filterInput === null
			? state.statusMessage
			: `Filter ${sectionTitle(state.filterInput.section)}: /${state.filterInput.draft}█`;
	const room = Math.max(size.columns - hintsWidth - 4, 8);
	return (
		<Box paddingX={1} justifyContent="space-between">
			<Text wrap="truncate">
				{message.length > room ? `${message.slice(0, room - 1)}…` : message}
			</Text>
			<Box gap={1}>
				{hints.map(([key, label]) => (
					<Text key={`${key}-${label}`}>
						<Text color="cyan">{key}</Text> <Text dimColor>{label}</Text>
					</Text>
				))}
			</Box>
		</Box>
	);
}

function sectionTitle(section: Section): string {
	return `${section[0]?.toUpperCase()}${section.slice(1)}`;
}

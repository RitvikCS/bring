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
import { Spinner } from '../direct/Spinner.js';
import { DoctorBlocked } from './DoctorBlocked.js';
import { keyToCommand, type TuiCommand } from './keymap.js';
import { LogView } from './LogView.js';
import {
	contentRows,
	layoutMode,
	listPaneWidth,
	logVisibleRows,
	MIN_COLUMNS,
	MIN_ROWS,
	type Size,
} from './layout.js';
import type { TuiEnvironment } from './load.js';
import { ConfirmRemove, HelpOverlay } from './modals.js';
import { OperationView } from './OperationView.js';
import {
	INITIAL_STATE,
	reduce,
	SECTIONS,
	type Section,
	selectedWorkspace,
	type TuiState,
	type TuiWorkspace,
} from './state.js';
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
	const size = sizeOverride ?? windowSize;
	const [state, dispatch] = useReducer(reduce, {
		...INITIAL_STATE,
		section: initialSection ?? 'workspaces',
	});
	// Effects read the latest state without re-subscribing useInput.
	const stateRef = useRef(state);
	stateRef.current = state;

	const refresh = useCallback(async () => {
		const workspaces = await environment.loadWorkspaces();
		dispatch({ type: 'refreshed', workspaces });
	}, [environment]);

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
			const workspaces = await environment.loadWorkspaces();
			if (!cancelled) {
				dispatch({ type: 'loaded', workspaces });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [state.phase, environment]);

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

	const runShell = useCallback(
		async (workspace: TuiWorkspace) => {
			// P1-42: the shell owns the terminal until it exits; Ink restores
			// the alternate screen and repaints when the suspension ends.
			await suspendTerminal(async () => {
				await environment.shell(workspace.ref);
			});
			dispatch({
				type: 'status-message',
				message: `Shell in ${workspace.name} closed.`,
			});
			await refresh();
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
			const operationRunning =
				current.operation !== null && current.operation.result === undefined;
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
							message: `Wait for ${current.operation?.operation} to finish (Ctrl+C aborts Bring).`,
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
				case 'move-section':
					dispatch({ type: 'move-section', delta: command.delta });
					return;
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
					if (selected === null || busy(selected)) {
						return;
					}
					runMutation('down', selected);
					return;
				case 'rebuild-or-refresh':
					if (selected !== null && selected.status === 'missing-config') {
						void refresh().then(() =>
							dispatch({ type: 'status-message', message: 'Checked again.' }),
						);
						return;
					}
					if (selected === null || busy(selected)) {
						return;
					}
					runMutation('rebuild', selected);
					return;
				case 'open-shell':
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
					dispatch({ type: 'open-confirm-remove' });
					return;
				case 'confirm-modal': {
					const modal = current.modal;
					if (modal?.kind !== 'confirm-remove') {
						return;
					}
					const target = current.workspaces.find(
						(w) => w.ref.rootPath === modal.workspacePath,
					);
					dispatch({ type: 'close-modal' });
					if (target !== undefined) {
						runMutation('remove', target);
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
			}
		},
		[exit, size, runMutation, runShell, openLogs, refresh],
	);

	useInput((input, key) => {
		const current = stateRef.current;
		const command = keyToCommand(input, key, {
			phase: current.phase,
			modal: current.modal?.kind ?? null,
			logViewOpen: current.logView !== null,
			operationRunning:
				current.operation !== null && current.operation.result === undefined,
			operationSettled: current.operation?.result !== undefined,
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
	if (modal?.kind === 'confirm-remove') {
		const target = state.workspaces.find(
			(w) => w.ref.rootPath === modal.workspacePath,
		);
		return target === undefined ? null : (
			<Box flexGrow={1} justifyContent="center" alignItems="center">
				<ConfirmRemove workspace={target} />
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
			<WorkspaceDetail workspace={selected} />
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
			borderColor={focused ? 'cyan' : 'gray'}
			paddingX={1}
			flexDirection="column"
			width={width}
			flexGrow={grow === true ? 1 : undefined}
		>
			{children}
		</Box>
	);
}

function StatusBar({ state, size }: { state: TuiState; size: Size }) {
	const hints =
		state.logView !== null
			? 'j/k scroll · Esc back'
			: state.modal !== null
				? 'Esc close'
				: 'h/l tabs · j/k select · ⏎ action · ? help · q quit';
	const message = state.statusMessage;
	const room = Math.max(size.columns - hints.length - 4, 8);
	return (
		<Box paddingX={1} justifyContent="space-between">
			<Text wrap="truncate">
				{message.length > room ? `${message.slice(0, room - 1)}…` : message}
			</Text>
			<Text dimColor>{hints}</Text>
		</Box>
	);
}

function sectionTitle(section: Section): string {
	return `${section[0]?.toUpperCase()}${section.slice(1)}`;
}

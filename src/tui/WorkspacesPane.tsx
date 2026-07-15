import { relative } from 'node:path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { WorkspaceStatus } from '../core/types.js';
import { KeyHints } from './KeyHints.js';
import {
	statusColor,
	statusLabel,
	statusSymbol,
	type TuiWorkspace,
} from './state.js';

// The Workspaces panes (P1-36/P1-37, blueprint §12.1): a symbol-led list on
// the left and a contextual detail on the right. Symbols carry state on
// their own; color only reinforces (spec: never color alone).

export function WorkspaceList({
	workspaces,
	selectedPath,
	focused,
	visibleRows,
}: {
	workspaces: readonly TuiWorkspace[];
	selectedPath: string | null;
	focused: boolean;
	visibleRows: number;
}) {
	if (workspaces.length === 0) {
		return (
			<Box flexDirection="column" gap={1}>
				<Text bold>WORKSPACES</Text>
				<Text dimColor>
					None yet — Bring remembers a project after its first `bring up`.
				</Text>
			</Box>
		);
	}
	const selectedIndex = Math.max(
		workspaces.findIndex((w) => w.ref.rootPath === selectedPath),
		0,
	);
	// Keep the selection inside the window (small lists rarely need this,
	// but a long registry must never push the selection off-screen).
	const rows = Math.max(visibleRows - 1, 1);
	const start = Math.min(
		Math.max(selectedIndex - Math.floor(rows / 2), 0),
		Math.max(workspaces.length - rows, 0),
	);
	const window = workspaces.slice(start, start + rows);
	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				WORKSPACES{' '}
				<Text dimColor>
					{selectedIndex + 1}/{workspaces.length}
				</Text>
			</Text>
			{window.map((workspace) => {
				const selected = workspace.ref.rootPath === selectedPath;
				return (
					<Text
						key={workspace.ref.rootPath}
						inverse={selected && focused}
						bold={selected}
					>
						<Text color={statusColor(workspace.status)}>
							{statusSymbol(workspace.status)}
						</Text>{' '}
						{workspace.name}
						{workspace.unregistered === true && (
							<Text dimColor> (this folder)</Text>
						)}
					</Text>
				);
			})}
		</Box>
	);
}

export function WorkspaceDetail({
	workspace,
	dotfilesRepository,
}: {
	workspace: TuiWorkspace | null;
	dotfilesRepository?: string | null;
}) {
	if (workspace === null) {
		return <Text dimColor>Nothing selected.</Text>;
	}
	if (workspace.status === 'missing-config') {
		return <MissingConfigDetail workspace={workspace} />;
	}
	return (
		<Box flexDirection="column">
			<Text bold>{workspace.name}</Text>
			<Text dimColor wrap="truncate-middle">
				{workspace.ref.rootPath}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<DetailRow label="Status">
					<Text color={statusColor(workspace.status)}>
						{statusSymbol(workspace.status)} {statusLabel(workspace.status)}
					</Text>
				</DetailRow>
				{workspace.containerIds.length > 0 && (
					<DetailRow label="Containers">
						<Text wrap="truncate">{workspace.containerIds.join(', ')}</Text>
					</DetailRow>
				)}
				{workspace.imageNames.length > 0 && (
					<DetailRow label="Image">
						<Text wrap="truncate-middle">
							{workspace.imageNames.join(', ')}
						</Text>
					</DetailRow>
				)}
				<DetailRow label="Config">
					<Text wrap="truncate">
						{relative(workspace.ref.rootPath, workspace.ref.configPath)}
					</Text>
				</DetailRow>
				{typeof dotfilesRepository === 'string' && (
					<DetailRow label="Dotfiles">
						<Text wrap="truncate-middle">
							{dotfilesRepository} <Text dimColor>(user default)</Text>
						</Text>
					</DetailRow>
				)}
			</Box>
			{workspace.status === 'failed' && workspace.problem !== undefined && (
				<Box marginTop={1} flexDirection="column">
					<Text color="red">! {workspace.problem.summary}</Text>
					{workspace.problem.remedy !== undefined && (
						<Text dimColor>Try: {workspace.problem.remedy}</Text>
					)}
				</Box>
			)}
			{workspace.status === 'not-created' && (
				<Box marginTop={1}>
					<Text dimColor>
						Never built on this machine — press u to bring it up.
					</Text>
				</Box>
			)}
			{workspace.forwardedPorts.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>Ports</Text>
					{workspace.forwardedPorts.map((port) => (
						<Text key={`${port.containerPort}-${port.hostPort ?? 'none'}`}>
							{port.containerPort} → localhost:
							{port.hostPort ?? port.containerPort}
						</Text>
					))}
				</Box>
			)}
			<Box marginTop={1}>
				<KeyHints hints={actionHints(workspace.status)} />
			</Box>
		</Box>
	);
}

function MissingConfigDetail({ workspace }: { workspace: TuiWorkspace }) {
	return (
		<Box flexDirection="column">
			<Text bold>{workspace.name}</Text>
			<Text dimColor>{workspace.ref.rootPath}</Text>
			<Box marginTop={1}>
				<Text color="red">! Configuration missing</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text>Bring looked for:</Text>
				<Text dimColor> .devcontainer/devcontainer.json</Text>
				<Text dimColor> .devcontainer.json</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					Configuration generation is not included in this release.
				</Text>
			</Box>
			<Box marginTop={1}>
				<KeyHints hints={[['r', 'Check again']]} />
			</Box>
		</Box>
	);
}

function DetailRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Box>
			<Box width={12} flexShrink={0}>
				<Text color="cyan" dimColor>
					{label}
				</Text>
			</Box>
			{children}
		</Box>
	);
}

function actionHints(status: WorkspaceStatus): [string, string][] {
	switch (status) {
		case 'running':
			return [
				['e', 'Shell'],
				['d', 'Down'],
				['r', 'Rebuild'],
				['L', 'Logs'],
				['x', 'Remove'],
			];
		case 'stopped':
			return [
				['u', 'Up'],
				['r', 'Rebuild'],
				['L', 'Logs'],
				['x', 'Remove'],
			];
		case 'failed':
			return [
				['u', 'Retry'],
				['r', 'Rebuild'],
				['L', 'Logs'],
				['x', 'Remove'],
			];
		case 'not-created':
			return [['u', 'Up']];
		default:
			return [];
	}
}

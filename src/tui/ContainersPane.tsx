import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { DevContainerResource } from '../core/resources.js';
import { KeyHints } from './KeyHints.js';
import { relativeTime } from './state.js';

export function ContainerList({
	containers,
	selectedId,
	focused,
	visibleRows,
}: {
	containers: readonly DevContainerResource[];
	selectedId: string | null;
	focused: boolean;
	visibleRows: number;
}) {
	if (containers.length === 0) {
		return (
			<Box flexDirection="column" gap={1}>
				<Text bold>CONTAINERS</Text>
				<Text dimColor>
					No Dev Container resources found. Bring only shows positively
					identified containers.
				</Text>
				<KeyHints hints={[['r', 'Refresh']]} />
			</Box>
		);
	}
	const selectedIndex = Math.max(
		containers.findIndex((container) => container.id === selectedId),
		0,
	);
	const rows = Math.max(visibleRows - 2, 1);
	const start = Math.min(
		Math.max(selectedIndex - Math.floor(rows / 2), 0),
		Math.max(containers.length - rows, 0),
	);
	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				CONTAINERS{' '}
				<Text dimColor>
					{selectedIndex + 1}/{containers.length}
				</Text>
			</Text>
			<Text dimColor>CONTAINER · WORKSPACE</Text>
			{containers.slice(start, start + rows).map((container) => {
				const selected = container.id === selectedId;
				return (
					<Text
						key={container.id}
						inverse={selected && focused}
						bold={selected}
						wrap="truncate"
					>
						<Text color={container.state === 'running' ? 'green' : undefined}>
							{container.state === 'running' ? '●' : '○'}
						</Text>{' '}
						{container.name} <Text dimColor>· {container.workspaceName}</Text>
					</Text>
				);
			})}
		</Box>
	);
}

export function ContainerDetail({
	container,
}: {
	container: DevContainerResource | null;
}) {
	if (container === null) {
		return <Text dimColor>Nothing selected.</Text>;
	}
	const created = relativeTime(container.createdAt, Date.now());
	return (
		<Box flexDirection="column">
			<Text bold>{container.name}</Text>
			<Text dimColor wrap="truncate-middle">
				{container.id}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<DetailRow label="Status">
					<Text color={container.state === 'running' ? 'green' : undefined}>
						{container.state === 'running' ? '●' : '○'}{' '}
						{container.statusText || container.state}
					</Text>
				</DetailRow>
				<DetailRow label="Workspace">
					<Text wrap="truncate-middle">{container.workspacePath}</Text>
				</DetailRow>
				<DetailRow label="Image">
					<Text wrap="truncate-middle">{container.imageName}</Text>
				</DetailRow>
				{created !== null && (
					<DetailRow label="Created">
						<Text>{created}</Text>
					</DetailRow>
				)}
				<DetailRow label="Role">
					<Text>
						{container.role === 'primary'
							? 'primary devcontainer'
							: `Compose service${container.serviceName === undefined ? '' : ` · ${container.serviceName}`}`}
					</Text>
				</DetailRow>
			</Box>
			{container.ports.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>Ports</Text>
					{container.ports.map((port) => (
						<Text key={`${port.containerPort}-${port.hostPort ?? 'none'}`}>
							{port.containerPort}
							{port.hostPort === undefined
								? ' (container only)'
								: ` → localhost:${port.hostPort}`}
						</Text>
					))}
				</Box>
			)}
			<Box marginTop={1}>
				<KeyHints
					hints={
						container.state === 'running'
							? [
									['e', 'Shell'],
									['d', 'Stop'],
									['x', 'Remove'],
								]
							: [
									['x', 'Remove'],
									['r', 'Refresh'],
								]
					}
				/>
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

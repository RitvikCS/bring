import { Box, Text } from 'ink';
import type {
	DevContainerImageResource,
	DevContainerResource,
} from '../core/resources.js';
import { formatBytes } from './ImagesPane.js';
import type { TuiWorkspace } from './state.js';

// Overlays (P1-40). Ink has no z-stack, so a modal replaces the content
// area — the header and status bar stay put, which keeps the spatial frame
// stable while making it unmistakable that keys now talk to the modal.

const HELP_ROWS: readonly [string, string][] = [
	['h/l', 'previous/next section'],
	['j/k', 'previous/next item'],
	['ctrl+h/l', 'focus left/right pane'],
	['Enter', 'primary action / open detail'],
	['u/d', 'workspace up/down · container stop with d'],
	['r', 'rebuild workspace / refresh resources'],
	['e', 'open workspace or container shell'],
	['L', 'latest log'],
	['x', 'removal confirmation'],
	['Space', 'select image for batch removal'],
	['p', 'review all unused images for pruning'],
	['Esc', 'close / back'],
	['q', 'quit'],
];

export function HelpOverlay() {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Keyboard help</Text>
			<Box marginTop={1} flexDirection="column">
				{HELP_ROWS.map(([keys, what]) => (
					<Box key={keys}>
						<Box width={11}>
							<Text color="cyan">{keys}</Text>
						</Box>
						<Text>{what}</Text>
					</Box>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Esc] Close</Text>
			</Box>
		</Box>
	);
}

export function ConfirmImageRemove({
	images,
}: {
	images: readonly DevContainerImageResource[];
}) {
	const upperBound = images.reduce(
		(total, image) => total + image.sizeBytes,
		0,
	);
	const workspaces = [
		...new Set(images.flatMap((image) => image.workspaceNames)),
	];
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="red"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>
				Remove {images.length} image{images.length === 1 ? '' : 's'}?
			</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>Up to {formatBytes(upperBound)} may be recovered.</Text>
				<Text dimColor>Shared layers mean actual recovery may be lower.</Text>
				{workspaces.length > 0 && (
					<Text>Affected workspaces may rebuild: {workspaces.join(', ')}</Text>
				)}
				<Text>Containers, volumes, and source files are not touched.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Remove [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

export function ConfirmContainerRemove({
	container,
}: {
	container: DevContainerResource;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="red"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Remove {container.name}?</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>The container will be stopped, then deleted.</Text>
				<Text>Images, volumes, and source files are not touched.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Remove [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

export function ConfirmRebuild({ workspace }: { workspace: TuiWorkspace }) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="yellow"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Rebuild {workspace.name}?</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>
					The container is deleted and rebuilt from the configuration —
				</Text>
				<Text>this can take a while. Source files are not touched.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Rebuild [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

export function ConfirmRemove({ workspace }: { workspace: TuiWorkspace }) {
	const count = workspace.containerIds.length;
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="red"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Remove {workspace.name}?</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>
					{count === 0
						? 'No containers exist right now — removing is a no-op.'
						: `${count} container${count === 1 ? '' : 's'} will be stopped and deleted.`}
				</Text>
				<Text>Source files are not touched.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Remove [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

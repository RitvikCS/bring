import { Box, Text } from 'ink';
import type {
	DevContainerImageResource,
	DevContainerResource,
} from '../core/resources.js';
import type { DotfilesProfile } from '../stores/profile-store.js';
import { formatBytes } from './ImagesPane.js';
import type { TuiWorkspace } from './state.js';

// Overlays (P1-40). Ink has no z-stack, so a modal replaces the content
// area — the header and status bar stay put, which keeps the spatial frame
// stable while making it unmistakable that keys now talk to the modal.

const HELP_ROWS: readonly [string, string][] = [
	['1-4 · h/l', 'jump to / cycle sections'],
	['j/k · ↑/↓', 'previous / next item'],
	['Tab · C-h/l', 'cycle / directly focus panes'],
	['Enter · Space', 'inspect / select image'],
	['u · d · e', 'workspace up · down/stop · shell'],
	['r · L', 'rebuild/refresh · latest log'],
	['x · p', 'confirmed removal · prune dangling images'],
	['f', 'forget a workspace (registry only — nothing deleted)'],
	['n/e · s · a', 'profile new/edit · default · assign'],
	['/', 'filter Containers or Images'],
	['Esc · q · ?', 'back/close · quit · help'],
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
						<Box width={16} flexShrink={0}>
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
	const baseCount = images.filter((image) => image.usage === 'base').length;
	const unusedTaggedCount = images.filter(
		(image) => image.usage === 'unused' && !image.dangling,
	).length;
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
				{images.slice(0, 3).map((image) => (
					<Text key={image.id} wrap="truncate-middle">
						• {image.displayName}
					</Text>
				))}
				{images.length > 3 && (
					<Text dimColor>…and {images.length - 3} more</Text>
				)}
				{baseCount > 0 && (
					<Text color="yellow">
						{baseCount} cached base image{baseCount === 1 ? '' : 's'} support
						existing containers and may need to be pulled or rebuilt again.
					</Text>
				)}
				{unusedTaggedCount > 0 && (
					<Text>
						{unusedTaggedCount} unused tagged image
						{unusedTaggedCount === 1 ? '' : 's'} may still be named by a
						configuration.
					</Text>
				)}
				{workspaces.length > 0 && (
					<Text>Affected workspaces may rebuild: {workspaces.join(', ')}</Text>
				)}
				<Text>
					Existing containers, volumes, and source files are not touched.
				</Text>
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

/** Registry-only: the counterpart of `bring forget` for the TUI. */
export function ConfirmForget({ workspace }: { workspace: TuiWorkspace }) {
	const count = workspace.containerIds.length;
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="yellow"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Forget {workspace.name}?</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>Bring stops tracking this workspace — registry entry and</Text>
				<Text>captured logs are removed. Nothing else changes:</Text>
				<Text>
					{count === 0
						? 'no containers exist, and source files are never touched.'
						: `${count} container${count === 1 ? '' : 's'} keep${count === 1 ? 's' : ''} running; source files are never touched.`}
				</Text>
				<Text dimColor>
					A later `bring up` in that directory remembers it again.
				</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Forget [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

export function ConfirmProfileDelete({
	name,
	assignedCount,
	isDefault,
}: {
	name: string;
	assignedCount: number;
	isDefault: boolean;
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
			<Text bold>Delete profile {name}?</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>Only the profile entry is removed — nothing in any</Text>
				<Text>container or repository is touched.</Text>
				{isDefault && (
					<Text color="yellow">It is the default profile right now.</Text>
				)}
				{assignedCount > 0 && (
					<Text color="yellow">
						{assignedCount} workspace{assignedCount === 1 ? '' : 's'} will lose
						this override.
					</Text>
				)}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Delete [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

/** §15.4: repository and install command are shown before first use. */
export function ConfirmProfileUse({
	name,
	profile,
}: {
	name: string;
	profile: DotfilesProfile;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="yellow"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>First use of profile {name}</Text>
			<Box marginTop={1} flexDirection="column">
				<Text>This will run inside the container:</Text>
				<Text>
					<Text dimColor>repository </Text>
					{profile.repository}
				</Text>
				<Text>
					<Text dimColor>install </Text>
					{profile.installCommand ?? 'repository default'}
				</Text>
				{profile.targetPath !== undefined && (
					<Text>
						<Text dimColor>target </Text>
						{profile.targetPath}
					</Text>
				)}
				<Text dimColor>Nothing executes on this machine.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[Enter] Apply [n] Skip dotfiles [Esc] Cancel</Text>
			</Box>
		</Box>
	);
}

export function ChooseProfile({
	names,
	index,
	defaultHintKey = 's',
}: {
	names: readonly string[];
	index: number;
	defaultHintKey?: string;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Which dotfiles profile?</Text>
			<Box marginTop={1} flexDirection="column">
				{names.map((name, i) => (
					<Text key={name} inverse={i === index} bold={i === index}>
						○ {name}
					</Text>
				))}
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>
					Several profiles exist and none is the default yet.
				</Text>
				<Text dimColor>
					[Enter] Use once [{defaultHintKey}] Use + set default [n] No dotfiles
					[Esc] Cancel
				</Text>
			</Box>
		</Box>
	);
}

export function AssignProfile({
	name,
	paths,
	index,
	workspaceProfiles,
	workspaceName,
}: {
	name: string;
	paths: readonly string[];
	index: number;
	workspaceProfiles: Record<string, string>;
	workspaceName: (path: string) => string;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			paddingX={2}
			paddingY={1}
			alignSelf="center"
		>
			<Text bold>Assign profile {name} to a workspace</Text>
			<Box marginTop={1} flexDirection="column">
				{paths.map((path, i) => {
					const assigned = workspaceProfiles[path];
					return (
						<Text key={path} inverse={i === index} bold={i === index}>
							{assigned === name ? '●' : '○'} {workspaceName(path)}
							{assigned !== undefined && <Text dimColor> ({assigned})</Text>}
						</Text>
					);
				})}
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>
					An assignment overrides the default profile for that workspace.
				</Text>
				<Text dimColor>[Enter] Assign / unassign [Esc] Close</Text>
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

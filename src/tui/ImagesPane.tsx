import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { DevContainerImageResource } from '../core/resources.js';
import { KeyHints } from './KeyHints.js';
import { relativeTime } from './state.js';

export function ImageList({
	images,
	totalCount,
	filterQuery,
	selectedId,
	markedIds,
	focused,
	visibleRows,
}: {
	images: readonly DevContainerImageResource[];
	totalCount: number;
	filterQuery: string;
	selectedId: string | null;
	markedIds: readonly string[];
	focused: boolean;
	visibleRows: number;
}) {
	if (images.length === 0) {
		return (
			<Box flexDirection="column" gap={1}>
				<Text bold>IMAGES</Text>
				<Text dimColor>
					{filterQuery !== '' && totalCount > 0
						? `No matches for /${filterQuery}. Press Esc to clear the filter.`
						: 'No Dev Container images found. Bring ignores unrelated Docker images.'}
				</Text>
				<KeyHints hints={[['r', 'Refresh']]} />
			</Box>
		);
	}
	const selectedIndex = Math.max(
		images.findIndex((image) => image.id === selectedId),
		0,
	);
	const rows = Math.max(visibleRows - (filterQuery === '' ? 2 : 3), 1);
	const start = Math.min(
		Math.max(selectedIndex - Math.floor(rows / 2), 0),
		Math.max(images.length - rows, 0),
	);
	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				IMAGES{' '}
				<Text dimColor>
					{selectedIndex + 1}/{images.length} · {markedIds.length} selected
					{filterQuery === '' ? '' : ` · ${images.length}/${totalCount} match`}
				</Text>
			</Text>
			{filterQuery !== '' && (
				<Text dimColor wrap="truncate">
					Filter /{filterQuery}
				</Text>
			)}
			<Text dimColor> IMAGE · SIZE · USAGE</Text>
			{images.slice(start, start + rows).map((image) => {
				const selected = image.id === selectedId;
				const marked = markedIds.includes(image.id);
				return (
					<Text
						key={image.id}
						inverse={selected && focused}
						bold={selected}
						wrap="truncate"
					>
						{marked ? '*' : ' '}{' '}
						<Text color={image.inUse ? 'green' : undefined}>
							{image.inUse ? '●' : image.dangling ? '◇' : '○'}
						</Text>{' '}
						{image.displayName}{' '}
						<Text dimColor>
							· {formatBytes(image.sizeBytes)} · {usageLabel(image)}
						</Text>
					</Text>
				);
			})}
		</Box>
	);
}

export function ImageDetail({
	image,
	marked,
}: {
	image: DevContainerImageResource | null;
	marked: boolean;
}) {
	if (image === null) {
		return <Text dimColor>Nothing selected.</Text>;
	}
	const created = relativeTime(image.createdAt, Date.now());
	return (
		<Box flexDirection="column">
			<Text bold>{image.displayName}</Text>
			<Text dimColor wrap="truncate-middle">
				{image.id}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<DetailRow label="Size">
					<Text>{formatBytes(image.sizeBytes)}</Text>
				</DetailRow>
				{created !== null && (
					<DetailRow label="Created">
						<Text>{created}</Text>
					</DetailRow>
				)}
				<DetailRow label="Usage">
					<Text color={image.inUse ? 'green' : undefined}>
						{image.inUse
							? '● In use'
							: image.dangling
								? '◇ Dangling'
								: '○ Unused'}
					</Text>
				</DetailRow>
				<DetailRow label="Selected">
					<Text>{marked ? '* yes' : 'no'}</Text>
				</DetailRow>
			</Box>
			{image.references.length > 1 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>References</Text>
					{image.references.slice(0, 4).map((reference) => (
						<Text key={reference} wrap="truncate-middle">
							{reference}
						</Text>
					))}
				</Box>
			)}
			{image.containerNames.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>Used by containers</Text>
					{image.containerNames.slice(0, 4).map((name) => (
						<Text key={name} wrap="truncate">
							{name}
						</Text>
					))}
				</Box>
			)}
			{image.workspaceNames.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>Workspace impact</Text>
					<Text wrap="truncate">{image.workspaceNames.join(', ')}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<KeyHints
					hints={
						image.inUse
							? [
									['r', 'Refresh'],
									['p', 'Prune unused'],
								]
							: [
									['Space', marked ? 'Unselect' : 'Select'],
									['x', 'Remove'],
									['p', 'Prune unused'],
								]
					}
				/>
			</Box>
		</Box>
	);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'kB', 'MB', 'GB', 'TB'] as const;
	const index = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
	const value = bytes / 1000 ** index;
	return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function usageLabel(image: DevContainerImageResource): string {
	return image.inUse ? 'in use' : image.dangling ? 'dangling' : 'unused';
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

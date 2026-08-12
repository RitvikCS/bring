import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { KeyHints } from './KeyHints.js';
import type { ProfileFormState, TuiState } from './state.js';

// The Profiles panes (P3-06/P3-07, spec §12.7): named dotfiles profiles on
// the left, the selected profile's contents on the right, and a terminal
// form for create/edit. Nothing here executes anything — profiles only ever
// become flags on the upstream CLI.

export function ProfileList({
	names,
	defaultProfile,
	selectedName,
	focused,
	visibleRows,
}: {
	names: readonly string[];
	defaultProfile: string | null;
	selectedName: string | null;
	focused: boolean;
	visibleRows: number;
}) {
	if (names.length === 0) {
		return (
			<Box flexDirection="column" gap={1}>
				<Text bold>DOTFILE PROFILES</Text>
				<Text dimColor>
					None yet — press n to create one. A profile is a dotfiles repo (plus
					optional install command) applied inside every container Bring
					creates.
				</Text>
			</Box>
		);
	}
	const selectedIndex =
		selectedName === null ? 0 : Math.max(names.indexOf(selectedName), 0);
	const rows = Math.max(visibleRows - 1, 1);
	const start = Math.min(
		Math.max(selectedIndex - Math.floor(rows / 2), 0),
		Math.max(names.length - rows, 0),
	);
	const window = names.slice(start, start + rows);
	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				DOTFILE PROFILES{' '}
				<Text dimColor>
					{selectedIndex + 1}/{names.length}
				</Text>
			</Text>
			{window.map((name) => {
				const selected = name === selectedName;
				const isDefault = name === defaultProfile;
				return (
					<Text key={name} inverse={selected && focused} bold={selected}>
						{isDefault ? '●' : '○'} {name}
						{isDefault && <Text dimColor> (default)</Text>}
					</Text>
				);
			})}
		</Box>
	);
}

export function ProfileDetail({ state }: { state: TuiState }) {
	const name = state.selectedProfileName;
	const profile = name === null ? undefined : state.profiles[name];
	if (name === null || profile === undefined) {
		return <Text dimColor>No profile selected — press n to create one.</Text>;
	}
	const assignedWorkspaces = Object.entries(state.workspaceProfiles)
		.filter(([, assigned]) => assigned === name)
		.map(([path]) => path);
	const confirmed = state.profileConfirmations[name] !== undefined;
	return (
		<Box flexDirection="column">
			<Text bold wrap="truncate">
				{name}
				{name === state.defaultProfile && <Text dimColor> (default)</Text>}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<DetailRow label="Repository">
					<Text wrap="truncate-middle">{profile.repository}</Text>
				</DetailRow>
				<DetailRow label="Install">
					<Text wrap="truncate">
						{profile.installCommand ?? <Text dimColor>repository default</Text>}
					</Text>
				</DetailRow>
				<DetailRow label="Target">
					<Text wrap="truncate">
						{profile.targetPath ?? <Text dimColor>upstream default</Text>}
					</Text>
				</DetailRow>
				<DetailRow label="First use">
					{confirmed ? (
						<Text>confirmed on this machine</Text>
					) : (
						<Text dimColor>will ask before the first up</Text>
					)}
				</DetailRow>
			</Box>
			{assignedWorkspaces.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>Assigned workspaces</Text>
					{assignedWorkspaces.map((path) => (
						<Text key={path} dimColor wrap="truncate-middle">
							{path}
						</Text>
					))}
				</Box>
			)}
			<Box marginTop={1}>
				<KeyHints
					hints={[
						['a', 'Assign'],
						['s', name === state.defaultProfile ? 'Undefault' : 'Default'],
						['e', 'Edit'],
						['n', 'New'],
						['x', 'Delete'],
					]}
				/>
			</Box>
		</Box>
	);
}

const FORM_LABELS: readonly [string, string][] = [
	['Name', 'e.g. personal'],
	['Repository', 'e.g. https://github.com/you/dotfiles'],
	['Install command', 'optional — upstream auto-detects install.sh etc.'],
	['Target path', 'optional — where the repo is cloned in the container'],
];

export function ProfileForm({ form }: { form: ProfileFormState }) {
	const values = [
		form.fields.name,
		form.fields.repository,
		form.fields.installCommand,
		form.fields.targetPath,
	];
	return (
		<Box flexDirection="column">
			<Text bold>
				{form.mode === 'create'
					? 'New dotfiles profile'
					: `Edit profile ${form.originalName}`}
			</Text>
			<Box marginTop={1} flexDirection="column">
				{FORM_LABELS.map(([label, placeholder], index) => {
					const focused = index === form.focus;
					const value = values[index] ?? '';
					return (
						<Box key={label}>
							<Box width={17} flexShrink={0}>
								<Text color="cyan" dimColor={!focused} bold={focused}>
									{focused ? '› ' : '  '}
									{label}
								</Text>
							</Box>
							{value === '' && !focused ? (
								<Text dimColor wrap="truncate">
									{placeholder}
								</Text>
							) : (
								<Text wrap="truncate">
									{value}
									{focused && <Text inverse> </Text>}
								</Text>
							)}
						</Box>
					);
				})}
			</Box>
			{form.error !== null && (
				<Box marginTop={1}>
					<Text color="red">! {form.error}</Text>
				</Box>
			)}
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>
					The install command runs inside containers only — never on this
					machine.
				</Text>
				<KeyHints
					hints={[
						['Tab/↑↓', 'Field'],
						['Enter', 'Save'],
						['Esc', 'Cancel'],
					]}
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

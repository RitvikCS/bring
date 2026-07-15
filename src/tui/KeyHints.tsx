import { Box, Text } from 'ink';

/**
 * Action hints with the key visually separated from its label — the key in
 * the accent color, the label dim — so available actions read at a glance
 * instead of as a wall of bracketed text.
 */
export function KeyHints({
	hints,
}: {
	hints: readonly (readonly [string, string])[];
}) {
	return (
		<Box gap={2} flexWrap="wrap">
			{hints.map(([key, label]) => (
				<Text key={`${key}-${label}`}>
					<Text color="cyan">[{key}]</Text> <Text dimColor>{label}</Text>
				</Text>
			))}
		</Box>
	);
}

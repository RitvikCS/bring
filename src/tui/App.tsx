import { Box, Text } from 'ink';

// Phase 0 placeholder for the full-screen interface (spec §11). It proves
// the Ink render path end to end; Phase 1 replaces it with the Workspaces
// screen on the alternate screen.
export function App({ version }: { version: string }) {
	return (
		<Box flexDirection="column">
			<Text>
				<Text bold>bring</Text> {version}
			</Text>
			<Text>
				The full-screen interface is not built yet — this is an early
				development release.
			</Text>
			<Text dimColor>
				Run `bring --help` to see where the product is going.
			</Text>
		</Box>
	);
}

import { Box, Text } from 'ink';
import type { LogViewState } from './state.js';

// Latest-log view (P1-41): the captured output of the last operation,
// scrolled with j/k. Esc returns to wherever the user was.

export function LogView({
	log,
	visibleRows,
}: {
	log: LogViewState;
	visibleRows: number;
}) {
	const start = Math.min(
		log.scroll,
		Math.max(log.lines.length - visibleRows, 0),
	);
	// Line numbers are the identity of log lines — stable across scrolls.
	const window = log.lines
		.slice(start, start + visibleRows)
		.map((text, offset) => ({ text, lineNumber: start + offset + 1 }));
	return (
		<Box flexDirection="column">
			<Text bold>
				{log.workspaceName} <Text dimColor>— latest log</Text>
			</Text>
			{window.map((line) => (
				<Text key={line.lineNumber} wrap="truncate">
					{line.text.length > 0 ? line.text : ' '}
				</Text>
			))}
			<Box marginTop={1}>
				<Text dimColor>
					lines {log.lines.length === 0 ? 0 : start + 1}–
					{Math.min(start + visibleRows, log.lines.length)} of{' '}
					{log.lines.length} · j/k scroll · g/G ends · Esc back
				</Text>
			</Box>
		</Box>
	);
}

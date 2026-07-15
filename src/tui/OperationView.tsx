import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { Spinner } from '../direct/Spinner.js';
import { formatDuration, type OperationProgress } from './state.js';

// The active-operation pane (P1-39, blueprint §12.2). Stages are the ones
// the operation actually emitted, in order — the spec forbids invented
// progress, so an unparsed build shows a spinner and the latest safe line.

export function OperationView({ progress }: { progress: OperationProgress }) {
	const settled = progress.result !== undefined;
	const done = progress.stages.slice(0, -1);
	const current = progress.stages.at(-1);
	return (
		<Box flexDirection="column">
			<Text bold>
				{progress.workspaceName}{' '}
				<Text color="yellow">
					{settled ? '' : '◆ '}
					{settled ? '' : `${progress.operation}…`}
				</Text>
			</Text>
			<Box marginTop={1} flexDirection="column">
				{done.map((stage) => (
					<Text key={stage.seq}>
						<Text color="green">✓</Text> {stage.message}
					</Text>
				))}
				{current !== undefined && !settled && (
					<Text>
						<Spinner /> {current.message} <Elapsed since={progress.startedAt} />
					</Text>
				)}
				{current !== undefined && settled && (
					<Text>
						<Text color="green">✓</Text> {current.message}
					</Text>
				)}
			</Box>
			{!settled && progress.lastOutput.length > 0 && (
				<Box marginTop={1}>
					<Text dimColor wrap="truncate">
						Current: {progress.lastOutput}
					</Text>
				</Box>
			)}
			{settled && progress.result !== undefined && (
				<Box marginTop={1} flexDirection="column">
					{progress.result.outcome === 'success' ? (
						<Text color="green">
							✓ {progress.result.message} (
							{formatDuration(progress.result.durationMs)})
						</Text>
					) : (
						<>
							<Text color="red">✗ {progress.result.message}</Text>
							{progress.result.problem?.remedy !== undefined && (
								<Text dimColor>Try: {progress.result.problem.remedy}</Text>
							)}
						</>
					)}
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>
					{settled
						? progress.result?.outcome === 'success'
							? '[Enter] Continue'
							: '[Enter] Continue  [L] Show captured output'
						: '[L] Show captured output'}
				</Text>
			</Box>
		</Box>
	);
}

function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(Math.floor((now - since) / 1000), 0);
	const minutes = Math.floor(seconds / 60);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		<Text dimColor>
			{pad(minutes)}:{pad(seconds % 60)}
		</Text>
	);
}

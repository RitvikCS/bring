import { Box, Text } from 'ink';
import type { DoctorReport } from '../application/doctor.js';

// Doctor-blocked screen (P1-43, spec §11.5): the TUI refuses to pretend
// everything works when a dependency is broken. Same checks as
// `bring doctor`, plus the first concrete remedy, front and center.

export function DoctorBlocked({ report }: { report: DoctorReport }) {
	const firstProblem = report.checks.find(
		(check) => check.problem !== undefined,
	)?.problem;
	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold>Bring can't start yet</Text>
			<Box marginTop={1} flexDirection="column">
				{report.checks.map((check) => (
					<Box key={check.id}>
						<Box width={3}>
							<Text
								color={
									check.status === 'ok'
										? 'green'
										: check.status === 'failed'
											? 'red'
											: undefined
								}
								dimColor={check.status === 'skipped'}
							>
								{check.status === 'ok'
									? '✓'
									: check.status === 'failed'
										? '✗'
										: '–'}
							</Text>
						</Box>
						<Box width={22}>
							<Text>{check.label}</Text>
						</Box>
						<Text dimColor wrap="truncate">
							{check.detail}
						</Text>
					</Box>
				))}
			</Box>
			{firstProblem !== undefined && (
				<Box marginTop={1} flexDirection="column">
					<Text color="red">{firstProblem.summary}</Text>
					{firstProblem.remedy !== undefined && (
						<Text>Fix: {firstProblem.remedy}</Text>
					)}
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>[r] Check again [q] Quit</Text>
			</Box>
		</Box>
	);
}

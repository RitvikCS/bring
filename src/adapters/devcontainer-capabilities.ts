import { type ProbeResult, probeCommand } from './probe-command.js';

// Bring refuses to run against a devcontainer CLI that lacks any of these
// subcommands (spec §5.7). Version numbers are never trusted as a proxy.
// The upstream CLI has no lifecycle stop/down commands (verified against
// 0.87.0) — Bring's down/remove operate through Docker on containers carrying
// the devcontainer.local_folder label, so only these three are required here.
export const REQUIRED_COMMANDS = ['up', 'exec', 'read-configuration'] as const;

export interface CapabilitySet {
	commands: string[];
	missing: string[];
}

export type CapabilityDetection =
	| { outcome: 'detected'; capabilities: CapabilitySet }
	| { outcome: 'probe-failed'; detail: string };

/**
 * Extract the supported-subcommand set from `devcontainer --help` output
 * (P1-03). Pure parsing so fixtures can cover it without spawning anything.
 */
export function parseDevcontainerCapabilities(helpText: string): CapabilitySet {
	const commands: string[] = [];
	const missing: string[] = [];
	for (const command of REQUIRED_COMMANDS) {
		// Help output lists subcommands as `devcontainer <name> ...` or as an
		// indented `<name>` line; match the word at a command position only.
		const listed = new RegExp(
			`^\\s*(?:devcontainer\\s+)?${command}(?:\\s|$)`,
			'm',
		).test(helpText);
		(listed ? commands : missing).push(command);
	}
	return { commands, missing };
}

// Capability sets are cached per process only (spec §5.7): a bring invocation
// probes each executable at most once, and nothing persists across runs.
const cache = new Map<string, CapabilityDetection>();

export async function detectDevcontainerCapabilities(
	executable: string,
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CapabilityDetection> {
	const cached = cache.get(executable);
	if (cached !== undefined) {
		return cached;
	}
	const probe = await probeCommand(executable, ['--help'], options);
	const detection = detectionFromProbe(probe);
	cache.set(executable, detection);
	return detection;
}

export function clearCapabilityCache(): void {
	cache.clear();
}

function detectionFromProbe(probe: ProbeResult): CapabilityDetection {
	if (probe.outcome === 'timed-out') {
		return {
			outcome: 'probe-failed',
			detail: `\`devcontainer --help\` did not answer within ${probe.timeoutMs}ms`,
		};
	}
	if (probe.outcome === 'spawn-failed') {
		return { outcome: 'probe-failed', detail: probe.message };
	}
	// Some CLIs print help to stderr and/or exit non-zero for --help;
	// parse whatever text came back before judging the exit code.
	const text = `${probe.stdout}\n${probe.stderr}`;
	const capabilities = parseDevcontainerCapabilities(text);
	if (capabilities.commands.length === 0) {
		return {
			outcome: 'probe-failed',
			detail: '`devcontainer --help` produced no recognizable command list',
		};
	}
	return { outcome: 'detected', capabilities };
}

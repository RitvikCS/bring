import { detectDevcontainerCapabilities } from '../adapters/devcontainer-capabilities.js';
import { findExecutable } from '../adapters/find-executable.js';
import { probeCommand } from '../adapters/probe-command.js';
import type { BringProblem } from '../core/errors.js';
import { bringStateDir } from '../stores/paths.js';

export type DoctorCheckId =
	| 'node'
	| 'devcontainer-cli'
	| 'devcontainer-capabilities'
	| 'docker-client'
	| 'docker-daemon'
	| 'bring-state';

export interface DoctorCheck {
	id: DoctorCheckId;
	label: string;
	status: 'ok' | 'failed' | 'skipped';
	/** One-line human detail: a version, a path, or what went wrong. */
	detail: string;
	problem?: BringProblem;
}

export interface DoctorReport {
	healthy: boolean;
	checks: DoctorCheck[];
}

export interface DoctorOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	nodeVersion?: string;
}

/**
 * Run every non-mutating diagnostic (P1-04, flow in spec §5.5).
 *
 * Doctor never installs, starts, or fixes anything — it distinguishes the
 * failure modes (CLI missing, capability gap, Docker missing, daemon stopped,
 * socket permission) precisely enough that the remedy is obvious.
 */
export async function runDoctor(
	options: DoctorOptions = {},
): Promise<DoctorReport> {
	const env = options.env ?? process.env;
	const probeOptions = { env, timeoutMs: options.timeoutMs };
	const checks: DoctorCheck[] = [];

	checks.push({
		id: 'node',
		label: 'Node.js',
		status: 'ok',
		detail: (options.nodeVersion ?? process.version).replace(/^v/, ''),
	});

	checks.push(...(await checkDevcontainer(env, probeOptions)));
	checks.push(...(await checkDocker(env, probeOptions)));

	checks.push({
		id: 'bring-state',
		label: 'Bring state',
		status: 'ok',
		detail: bringStateDir(env),
	});

	return { healthy: checks.every((c) => c.status !== 'failed'), checks };
}

interface ProbeOptionsShape {
	env: NodeJS.ProcessEnv;
	timeoutMs: number | undefined;
}

async function checkDevcontainer(
	env: NodeJS.ProcessEnv,
	probeOptions: ProbeOptionsShape,
): Promise<DoctorCheck[]> {
	const cliLabel = 'Dev Containers CLI';
	const capsLabel = 'CLI capabilities';
	const executable = findExecutable('devcontainer', env['PATH']);

	if (executable === null) {
		return [
			{
				id: 'devcontainer-cli',
				label: cliLabel,
				status: 'failed',
				detail: 'not found on PATH',
				problem: {
					code: 'DEPENDENCY_MISSING',
					summary: 'Bring needs the Dev Containers CLI.',
					remedy: 'npm install -g @devcontainers/cli',
				},
			},
			skipped('devcontainer-capabilities', capsLabel, 'CLI not found'),
		];
	}

	const version = await probeCommand(executable, ['--version'], probeOptions);
	if (version.outcome !== 'completed' || version.exitCode !== 0) {
		return [
			{
				id: 'devcontainer-cli',
				label: cliLabel,
				status: 'failed',
				detail: probeFailureDetail('devcontainer --version', version),
				problem: {
					code: 'DEPENDENCY_UNREACHABLE',
					summary: 'The Dev Containers CLI is installed but not responding.',
					remedy: 'devcontainer --version',
				},
			},
			skipped('devcontainer-capabilities', capsLabel, 'CLI not responding'),
		];
	}

	const cliCheck: DoctorCheck = {
		id: 'devcontainer-cli',
		label: cliLabel,
		status: 'ok',
		detail: version.stdout.trim() || 'installed',
	};

	const detection = await detectDevcontainerCapabilities(
		executable,
		probeOptions,
	);
	if (detection.outcome === 'probe-failed') {
		return [
			cliCheck,
			{
				id: 'devcontainer-capabilities',
				label: capsLabel,
				status: 'failed',
				detail: detection.detail,
				problem: {
					code: 'DEPENDENCY_UNREACHABLE',
					summary: 'Could not inspect what the Dev Containers CLI supports.',
					remedy: 'devcontainer --help',
				},
			},
		];
	}
	const { missing, commands } = detection.capabilities;
	if (missing.length > 0) {
		return [
			cliCheck,
			{
				id: 'devcontainer-capabilities',
				label: capsLabel,
				status: 'failed',
				detail: `missing: ${missing.join(', ')}`,
				problem: {
					code: 'UNSUPPORTED_CAPABILITY',
					summary: `The installed Dev Containers CLI does not support: ${missing.join(', ')}.`,
					remedy: 'npm install -g @devcontainers/cli@latest',
				},
			},
		];
	}
	return [
		cliCheck,
		{
			id: 'devcontainer-capabilities',
			label: capsLabel,
			status: 'ok',
			detail: commands.join(', '),
		},
	];
}

async function checkDocker(
	env: NodeJS.ProcessEnv,
	probeOptions: ProbeOptionsShape,
): Promise<DoctorCheck[]> {
	const clientLabel = 'Docker client';
	const daemonLabel = 'Docker daemon';
	const executable = findExecutable('docker', env['PATH']);

	if (executable === null) {
		return [
			{
				id: 'docker-client',
				label: clientLabel,
				status: 'failed',
				detail: 'not found on PATH',
				problem: {
					code: 'DEPENDENCY_MISSING',
					summary: 'Bring needs Docker.',
					remedy: 'Install Docker, then run: bring doctor',
				},
			},
			skipped('docker-daemon', daemonLabel, 'Docker not found'),
		];
	}

	const version = await probeCommand(executable, ['--version'], probeOptions);
	if (version.outcome !== 'completed' || version.exitCode !== 0) {
		return [
			{
				id: 'docker-client',
				label: clientLabel,
				status: 'failed',
				detail: probeFailureDetail('docker --version', version),
				problem: {
					code: 'DEPENDENCY_UNREACHABLE',
					summary: 'Docker is installed but the client is not responding.',
					remedy: 'docker --version',
				},
			},
			skipped('docker-daemon', daemonLabel, 'client not responding'),
		];
	}
	const clientCheck: DoctorCheck = {
		id: 'docker-client',
		label: clientLabel,
		status: 'ok',
		detail: parseDockerClientVersion(version.stdout),
	};

	// `docker context show` works without a reachable daemon, so the failure
	// message can still name the context the user is pointed at (spec §5.6).
	const contextProbe = await probeCommand(
		executable,
		['context', 'show'],
		probeOptions,
	);
	const context =
		contextProbe.outcome === 'completed' && contextProbe.exitCode === 0
			? contextProbe.stdout.trim()
			: 'unknown';

	const info = await probeCommand(
		executable,
		['info', '--format', '{{.ServerVersion}}'],
		probeOptions,
	);
	if (info.outcome === 'completed' && info.exitCode === 0) {
		return [
			clientCheck,
			{
				id: 'docker-daemon',
				label: daemonLabel,
				status: 'ok',
				detail: `reachable · context ${context}`,
			},
		];
	}

	const stderr = info.outcome === 'completed' ? info.stderr : '';
	if (/permission denied/i.test(stderr)) {
		return [
			clientCheck,
			{
				id: 'docker-daemon',
				label: daemonLabel,
				status: 'failed',
				detail: `permission denied · context ${context}`,
				problem: {
					code: 'DEPENDENCY_UNREACHABLE',
					summary:
						'Docker is running, but your user is not allowed to talk to it.',
					remedy:
						'Add yourself to the docker group (or use rootless Docker), then log in again.',
				},
			},
		];
	}
	return [
		clientCheck,
		{
			id: 'docker-daemon',
			label: daemonLabel,
			status: 'failed',
			detail: `unreachable · context ${context}`,
			problem: {
				code: 'DEPENDENCY_UNREACHABLE',
				summary:
					'Docker is installed, but Bring cannot reach the Docker daemon.',
				remedy:
					'Start Docker Desktop or the Docker service, then run: bring doctor',
			},
		},
	];
}

function skipped(
	id: DoctorCheckId,
	label: string,
	reason: string,
): DoctorCheck {
	return { id, label, status: 'skipped', detail: `skipped — ${reason}` };
}

function probeFailureDetail(
	command: string,
	probe: Awaited<ReturnType<typeof probeCommand>>,
): string {
	switch (probe.outcome) {
		case 'timed-out':
			return `\`${command}\` did not answer within ${probe.timeoutMs}ms`;
		case 'spawn-failed':
			return `\`${command}\` could not start: ${probe.message}`;
		case 'completed':
			return `\`${command}\` exited with code ${probe.exitCode}`;
	}
}

function parseDockerClientVersion(stdout: string): string {
	// "Docker version 28.1.1, build 4eba377" → "28.1.1"
	const match = stdout.match(/Docker version ([^,\s]+)/);
	return match?.[1] ?? stdout.trim();
}

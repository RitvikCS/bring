import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCapabilityCache } from '../../src/adapters/devcontainer-capabilities.js';
import { type DoctorReport, runDoctor } from '../../src/application/doctor.js';
import {
	HEALTHY_DEVCONTAINER,
	HEALTHY_DOCKER,
	makeBinDir,
	permissionDeniedDocker,
	stoppedDaemonDocker,
	writeFakeBin,
} from '../helpers/fake-bin.js';

function doctorWith(binDir: string): Promise<DoctorReport> {
	return runDoctor({
		env: { PATH: binDir, HOME: '/home/test' },
		nodeVersion: 'v24.4.1',
		timeoutMs: 2_000,
	});
}

function check(report: DoctorReport, id: string) {
	const found = report.checks.find((c) => c.id === id);
	if (found === undefined) {
		throw new Error(`missing check ${id}`);
	}
	return found;
}

describe('runDoctor', () => {
	beforeEach(() => {
		clearCapabilityCache();
	});

	it('reports healthy when every dependency responds', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'devcontainer', HEALTHY_DEVCONTAINER);
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);

		const report = await doctorWith(dir);

		expect(report.healthy).toBe(true);
		expect(check(report, 'node').detail).toBe('24.4.1');
		expect(check(report, 'devcontainer-cli').detail).toBe('0.87.0');
		expect(check(report, 'docker-client').detail).toBe('28.1.1');
		expect(check(report, 'docker-daemon').detail).toBe(
			'reachable · context default',
		);
		expect(check(report, 'bring-state').detail).toBe(
			'/home/test/.local/state/bring',
		);
	});

	it('honours XDG_STATE_HOME for the state path', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'devcontainer', HEALTHY_DEVCONTAINER);
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);

		const report = await runDoctor({
			env: { PATH: dir, HOME: '/home/test', XDG_STATE_HOME: '/xdg/state' },
			nodeVersion: 'v24.4.1',
			timeoutMs: 2_000,
		});
		expect(check(report, 'bring-state').detail).toBe('/xdg/state/bring');
	});

	it('diagnoses a missing Dev Containers CLI and skips its capabilities', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);

		// Without the opt-out, the copy Bring bundles as a dependency would be
		// found and this scenario could never occur on a healthy install.
		const report = await runDoctor({
			env: {
				PATH: dir,
				HOME: '/home/test',
				BRING_NO_BUNDLED_DEVCONTAINER: '1',
			},
			nodeVersion: 'v24.4.1',
			timeoutMs: 2_000,
		});

		expect(report.healthy).toBe(false);
		const cli = check(report, 'devcontainer-cli');
		expect(cli.status).toBe('failed');
		expect(cli.problem?.code).toBe('DEPENDENCY_MISSING');
		expect(cli.problem?.remedy).toBe(
			'npm install -g @devcontainers/cli (or reinstall Bring)',
		);
		expect(check(report, 'devcontainer-capabilities').status).toBe('skipped');
		expect(check(report, 'docker-daemon').status).toBe('ok');
	});

	it('falls back to the bundled Dev Containers CLI when PATH has none', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);
		// The bundled .bin shim is a `#!/usr/bin/env node` script; give the
		// isolated PATH a real node without leaking a real devcontainer in.
		symlinkSync(process.execPath, join(dir, 'node'));

		const report = await doctorWith(dir);

		// The dependency copy answers the probes, and doctor says which copy
		// it is so a surprising version has an obvious explanation.
		const cli = check(report, 'devcontainer-cli');
		expect(cli.status).toBe('ok');
		expect(cli.detail).toContain('(bundled with Bring)');
	});

	it('diagnoses a capability gap in the installed CLI', async () => {
		const dir = makeBinDir();
		const withoutExec = HEALTHY_DEVCONTAINER.split('\n')
			.filter((line) => !line.includes('devcontainer exec'))
			.join('\n');
		writeFakeBin(dir, 'devcontainer', withoutExec);
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);

		const report = await doctorWith(dir);

		expect(report.healthy).toBe(false);
		const caps = check(report, 'devcontainer-capabilities');
		expect(caps.status).toBe('failed');
		expect(caps.problem?.code).toBe('UNSUPPORTED_CAPABILITY');
		expect(caps.detail).toBe('missing: exec');
	});

	it('diagnoses missing Docker and skips the daemon check', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'devcontainer', HEALTHY_DEVCONTAINER);

		const report = await doctorWith(dir);

		expect(report.healthy).toBe(false);
		expect(check(report, 'docker-client').problem?.code).toBe(
			'DEPENDENCY_MISSING',
		);
		expect(check(report, 'docker-daemon').status).toBe('skipped');
	});

	it('distinguishes a stopped daemon from a permission problem', async () => {
		const stopped = makeBinDir();
		writeFakeBin(stopped, 'devcontainer', HEALTHY_DEVCONTAINER);
		writeFakeBin(stopped, 'docker', stoppedDaemonDocker());
		const stoppedReport = await doctorWith(stopped);
		const stoppedDaemon = check(stoppedReport, 'docker-daemon');
		expect(stoppedDaemon.status).toBe('failed');
		expect(stoppedDaemon.detail).toBe('unreachable · context default');
		expect(stoppedDaemon.problem?.code).toBe('DEPENDENCY_UNREACHABLE');
		expect(stoppedDaemon.problem?.summary).toContain(
			'cannot reach the Docker daemon',
		);

		const denied = makeBinDir();
		writeFakeBin(denied, 'devcontainer', HEALTHY_DEVCONTAINER);
		writeFakeBin(denied, 'docker', permissionDeniedDocker());
		const deniedReport = await doctorWith(denied);
		const deniedDaemon = check(deniedReport, 'docker-daemon');
		expect(deniedDaemon.status).toBe('failed');
		expect(deniedDaemon.detail).toBe('permission denied · context default');
		expect(deniedDaemon.problem?.summary).toContain('not allowed');
	});

	it('diagnoses a CLI that hangs instead of answering', async () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'devcontainer', 'exec /bin/sleep 30');
		writeFakeBin(dir, 'docker', HEALTHY_DOCKER);

		const report = await runDoctor({
			env: { PATH: dir, HOME: '/home/test' },
			nodeVersion: 'v24.4.1',
			timeoutMs: 200,
		});

		expect(report.healthy).toBe(false);
		const cli = check(report, 'devcontainer-cli');
		expect(cli.status).toBe('failed');
		expect(cli.problem?.code).toBe('DEPENDENCY_UNREACHABLE');
		expect(cli.detail).toContain('did not answer within 200ms');
	});
});

import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/application/doctor.js';
import {
	renderDoctorHuman,
	renderDoctorJson,
} from '../../src/cli/render-doctor.js';

const HEALTHY: DoctorReport = {
	healthy: true,
	checks: [
		{ id: 'node', label: 'Node.js', status: 'ok', detail: '24.4.1' },
		{
			id: 'devcontainer-cli',
			label: 'Dev Containers CLI',
			status: 'ok',
			detail: '0.87.0',
		},
		{
			id: 'docker-daemon',
			label: 'Docker daemon',
			status: 'ok',
			detail: 'reachable · context default',
		},
	],
};

const MISSING_CLI: DoctorReport = {
	healthy: false,
	checks: [
		{ id: 'node', label: 'Node.js', status: 'ok', detail: '24.4.1' },
		{
			id: 'devcontainer-cli',
			label: 'Dev Containers CLI',
			status: 'failed',
			detail: 'not found on PATH',
			problem: {
				code: 'DEPENDENCY_MISSING',
				summary: 'Bring needs the Dev Containers CLI.',
				remedy: 'npm install -g @devcontainers/cli',
			},
		},
		{
			id: 'devcontainer-capabilities',
			label: 'CLI capabilities',
			status: 'skipped',
			detail: 'skipped — CLI not found',
		},
	],
};

describe('renderDoctorHuman', () => {
	it('ends a healthy report with Ready.', () => {
		const output = renderDoctorHuman(HEALTHY);
		expect(output).toContain('✓ Node.js');
		expect(output).toContain('✓ Docker daemon');
		expect(output.endsWith('Ready.')).toBe(true);
	});

	it('aligns details across differently sized labels', () => {
		const output = renderDoctorHuman(HEALTHY);
		expect(output).toContain('✓ Node.js             24.4.1');
		expect(output).toContain('✓ Dev Containers CLI  0.87.0');
	});

	it('explains a failure with its remedy and the no-changes promise', () => {
		const output = renderDoctorHuman(MISSING_CLI);
		expect(output).toContain('✗ Dev Containers CLI');
		expect(output).toContain('Bring needs the Dev Containers CLI.');
		expect(output).toContain('npm install -g @devcontainers/cli');
		expect(output).toContain('Nothing was changed by Bring.');
	});
});

describe('renderDoctorJson', () => {
	it('emits parseable JSON without ANSI escapes', () => {
		const output = renderDoctorJson(MISSING_CLI);
		expect(output).not.toContain('\u001b');
		const parsed = JSON.parse(output);
		expect(parsed.healthy).toBe(false);
		expect(parsed.errorCode).toBe('DEPENDENCY_MISSING');
		expect(parsed.checks).toHaveLength(3);
		expect(parsed.checks[1].problem.remedy).toBe(
			'npm install -g @devcontainers/cli',
		);
	});

	it('omits errorCode when healthy', () => {
		const parsed = JSON.parse(renderDoctorJson(HEALTHY));
		expect(parsed.healthy).toBe(true);
		expect('errorCode' in parsed).toBe(false);
	});
});

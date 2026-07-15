import { describe, expect, it } from 'vitest';
import {
	classifyDevcontainerFailure,
	exitCodeForProblem,
} from '../../src/core/errors.js';

describe('exitCodeForProblem', () => {
	it.each([
		['USAGE_ERROR', 2],
		['WORKSPACE_NOT_FOUND', 3],
		['CONFIG_NOT_FOUND', 3],
		['CONFIG_AMBIGUOUS', 3],
		['DEPENDENCY_MISSING', 4],
		['UNSUPPORTED_CAPABILITY', 4],
		['DEVCONTAINER_FAILED', 1],
		['DOCKER_FAILED', 1],
		['OPERATION_CONFLICT', 1],
		['USER_CANCELLED', 0],
		['INTERRUPTED', 130],
		['INTERNAL_ERROR', 5],
	] as const)('%s → exit %i', (code, exit) => {
		expect(exitCodeForProblem(code)).toBe(exit);
	});
});

describe('classifyDevcontainerFailure', () => {
	it('recognizes a dying daemon', () => {
		const problem = classifyDevcontainerFailure(
			'Cannot connect to the Docker daemon at unix:///run/docker.sock',
			1,
		);
		expect(problem.summary).toContain('Docker stopped responding');
		expect(problem.remedy).toBe('bring doctor');
	});

	it('recognizes lifecycle-command failures', () => {
		const problem = classifyDevcontainerFailure(
			'postCreateCommand failed with exit code 127',
			1,
		);
		expect(problem.summary).toContain('lifecycle command');
	});

	it('recognizes image pull failures', () => {
		const problem = classifyDevcontainerFailure(
			'Error: pull access denied for ghcr.io/nope/image',
			1,
		);
		expect(problem.summary).toContain('could not be pulled');
	});

	it('falls back to the exit code for unknown output', () => {
		const problem = classifyDevcontainerFailure('mystery meat', 7);
		expect(problem.code).toBe('DEVCONTAINER_FAILED');
		expect(problem.summary).toContain('exited with code 7');
	});
});

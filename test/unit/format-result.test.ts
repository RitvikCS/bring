import { describe, expect, it } from 'vitest';
import type { OperationResult } from '../../src/core/operation-events.js';
import {
	formatResult,
	formatResultJson,
} from '../../src/direct/format-result.js';

const SUCCESS: OperationResult = {
	operation: 'up',
	outcome: 'success',
	workspace: '/home/me/proj',
	workspaceName: 'proj',
	message: 'proj ready',
	durationMs: 8421,
	containerIds: ['abc'],
};

const FAILURE: OperationResult = {
	operation: 'up',
	outcome: 'failed',
	workspace: '/home/me/proj',
	workspaceName: 'proj',
	message: 'A lifecycle command in devcontainer.json failed.',
	durationMs: 6200,
	containerIds: [],
	problem: {
		code: 'DEVCONTAINER_FAILED',
		summary: 'A lifecycle command in devcontainer.json failed.',
	},
	logPath: '/state/logs/x/latest.log',
};

describe('formatResult', () => {
	it('renders one success line with the duration', () => {
		const line = formatResult(SUCCESS);
		expect(line).toContain('✓ proj ready');
		expect(line).toContain('8.4s');
		expect(line.split('\n')).toHaveLength(1);
	});

	it('renders failure with log guidance, never the full log', () => {
		const text = formatResult(FAILURE);
		expect(text).toContain('✗ A lifecycle command');
		expect(text).toContain('logs');
		expect(text).toContain('--verbose');
		expect(text).not.toContain('/state/logs'); // path stays out of the summary
	});

	it('is plain by default and colored on request', () => {
		expect(formatResult(SUCCESS)).not.toContain('\u001b');
		expect(formatResult(SUCCESS, { color: true })).toContain('\u001b[32m');
		expect(formatResult(FAILURE, { color: true })).toContain('\u001b[31m');
	});
});

describe('formatResultJson', () => {
	it('emits schema v1 with stable error fields and no ANSI', () => {
		const doc = JSON.parse(formatResultJson(FAILURE));
		expect(doc).toMatchObject({
			schemaVersion: 1,
			operation: 'up',
			outcome: 'failed',
			workspace: '/home/me/proj',
			error: { code: 'DEVCONTAINER_FAILED' },
			logPath: '/state/logs/x/latest.log',
		});
		expect(formatResultJson(FAILURE)).not.toContain('\u001b');
	});

	it('omits error for success', () => {
		const doc = JSON.parse(formatResultJson(SUCCESS));
		expect(doc.outcome).toBe('success');
		expect('error' in doc).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import { helpText } from '../../src/cli/help.js';

describe('helpText', () => {
	const text = helpText('9.9.9');

	it('includes the version', () => {
		expect(text).toContain('bring 9.9.9');
	});

	// Spec §3 as amended: the upstream CLI has no stop/down commands, so the
	// required translation table speaks in docker terms instead.
	it('documents the down/remove semantic translation (spec §3)', () => {
		expect(text).toMatch(/bring down\s+acts like\s+docker stop/);
		expect(text).toMatch(/bring remove\s+acts like\s+docker rm/);
	});

	it('documents the doctor command', () => {
		expect(text).toContain('doctor');
		expect(text).toContain('--json');
	});

	it('documents direct entry to the Phase 2 resource sections', () => {
		expect(text).toContain('bring containers');
		expect(text).toContain('bring images');
	});

	it('warns that remove deletes while down preserves', () => {
		expect(text).toContain('DELETE');
		expect(text).toContain('source files are never touched');
	});

	it('lists both option spellings', () => {
		expect(text).toContain('--help, -h');
		expect(text).toContain('--version, -v');
	});
});

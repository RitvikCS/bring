import { describe, expect, it } from 'vitest';
import { helpText } from '../../src/cli/help.js';

describe('helpText', () => {
	const text = helpText('9.9.9');

	it('includes the version', () => {
		expect(text).toContain('bring 9.9.9');
	});

	it('documents the down/remove semantic translation (spec §3)', () => {
		expect(text).toContain('devcontainer stop');
		expect(text).toContain('devcontainer down');
		expect(text).toMatch(/bring down\s+runs\s+devcontainer stop/);
		expect(text).toMatch(/bring remove\s+runs\s+devcontainer down/);
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

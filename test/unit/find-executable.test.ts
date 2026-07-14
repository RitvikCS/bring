import { writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findExecutable } from '../../src/adapters/find-executable.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

describe('findExecutable', () => {
	it('finds an executable file on PATH', () => {
		const dir = makeBinDir();
		const expected = writeFakeBin(dir, 'devcontainer', 'exit 0');
		expect(findExecutable('devcontainer', dir)).toBe(expected);
	});

	it('returns null when the name is on no PATH entry', () => {
		expect(findExecutable('devcontainer', makeBinDir())).toBeNull();
	});

	it('returns null when PATH is undefined', () => {
		expect(findExecutable('devcontainer', undefined)).toBeNull();
	});

	it('skips files without the execute bit', () => {
		const dir = makeBinDir();
		writeFileSync(join(dir, 'docker'), '#!/bin/sh\n', { mode: 0o644 });
		expect(findExecutable('docker', dir)).toBeNull();
	});

	it('prefers the earlier PATH entry', () => {
		const first = makeBinDir();
		const second = makeBinDir();
		const winner = writeFakeBin(first, 'docker', 'exit 0');
		writeFakeBin(second, 'docker', 'exit 0');
		const pathValue = [first, second].join(delimiter);
		expect(findExecutable('docker', pathValue)).toBe(winner);
	});

	it('ignores empty and relative PATH entries', () => {
		const dir = makeBinDir();
		const expected = writeFakeBin(dir, 'docker', 'exit 0');
		const pathValue = ['', 'relative/bin', dir].join(delimiter);
		expect(findExecutable('docker', pathValue)).toBe(expected);
	});

	it('refuses names containing a path separator', () => {
		const dir = makeBinDir();
		writeFakeBin(dir, 'docker', 'exit 0');
		expect(findExecutable('./docker', dir)).toBeNull();
	});
});

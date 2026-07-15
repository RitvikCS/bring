import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	clearLogs,
	logDirFor,
	readLatestLog,
	writeOperationLog,
} from '../../src/stores/log-store.js';

const IDENTITY = 'abc123';

function tempStateDir(): string {
	return mkdtempSync(join(tmpdir(), 'bring-logs-'));
}

describe('log store', () => {
	it('writes and reads back the latest log', () => {
		const stateDir = tempStateDir();
		const path = writeOperationLog(stateDir, IDENTITY, 'first run\n');
		expect(path).toBe(join(stateDir, 'logs', IDENTITY, 'latest.log'));
		expect(readLatestLog(stateDir, IDENTITY)).toBe('first run\n');
	});

	it('returns null when no log exists', () => {
		expect(readLatestLog(tempStateDir(), IDENTITY)).toBeNull();
	});

	it('retains exactly the latest two logs', () => {
		const stateDir = tempStateDir();
		writeOperationLog(stateDir, IDENTITY, 'one');
		writeOperationLog(stateDir, IDENTITY, 'two');
		writeOperationLog(stateDir, IDENTITY, 'three');
		expect(readLatestLog(stateDir, IDENTITY)).toBe('three');
		const dir = logDirFor(stateDir, IDENTITY);
		expect(statSync(join(dir, 'previous.log')).isFile()).toBe(true);
	});

	it('creates user-only files and directories', () => {
		const stateDir = tempStateDir();
		const path = writeOperationLog(stateDir, IDENTITY, 'secret build output');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(logDirFor(stateDir, IDENTITY)).mode & 0o777).toBe(0o700);
	});

	it('clears logs idempotently', () => {
		const stateDir = tempStateDir();
		writeOperationLog(stateDir, IDENTITY, 'x');
		clearLogs(stateDir, IDENTITY);
		expect(readLatestLog(stateDir, IDENTITY)).toBeNull();
		clearLogs(stateDir, IDENTITY); // second clear is fine
	});
});

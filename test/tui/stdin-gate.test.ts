import { describe, expect, it } from 'vitest';
import { handTerminalToChild } from '../../src/tui/stdin-gate.js';

/**
 * A minimal stand-in for a TTY stdin: `read()` pops queued chunks, and the
 * fake records every call so the tests can assert the hand-over protocol
 * (drain THEN pause, drain again on reclaim) rather than real TTY behavior,
 * which vitest cannot provide.
 */
function fakeStdin(options: { isTTY: boolean; buffered?: string[] }) {
	const buffered = [...(options.buffered ?? [])];
	const calls: string[] = [];
	const stdin = {
		isTTY: options.isTTY,
		read(): string | null {
			calls.push('read');
			return buffered.shift() ?? null;
		},
		pause(): void {
			calls.push('pause');
		},
	};
	return {
		stdin: stdin as unknown as NodeJS.ReadStream,
		calls,
		queue: (chunk: string) => buffered.push(chunk),
	};
}

describe('handTerminalToChild', () => {
	it('drains buffered input, then pauses, before the child spawns', () => {
		const { stdin, calls } = fakeStdin({ isTTY: true, buffered: ['e', 'x'] });
		handTerminalToChild(stdin);
		// Two buffered chunks + the null that ends the drain, then the pause.
		expect(calls).toEqual(['read', 'read', 'read', 'pause']);
	});

	it('reclaim drains whatever arrived while the child ran', () => {
		const { stdin, calls, queue } = fakeStdin({ isTTY: true });
		const reclaim = handTerminalToChild(stdin);
		calls.length = 0;
		queue('exit\r');
		reclaim();
		expect(calls).toEqual(['read', 'read']);
	});

	it('does not touch a non-TTY stdin', () => {
		const { stdin, calls } = fakeStdin({ isTTY: false, buffered: ['e'] });
		const reclaim = handTerminalToChild(stdin);
		reclaim();
		expect(calls).toEqual([]);
	});
});

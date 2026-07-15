import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { OperationEvent } from '../../src/core/operation-events.js';
import { DirectOperation } from '../../src/direct/DirectOperation.js';

describe('DirectOperation', () => {
	it('shows a spinner frame with the latest stage message', async () => {
		let listener: ((event: OperationEvent) => void) | undefined;
		const subscribe = (l: (event: OperationEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		};

		const { lastFrame, unmount } = render(
			<DirectOperation subscribe={subscribe} initialMessage="Checking proj…" />,
		);
		expect(lastFrame()).toContain('Checking proj…');
		expect(lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

		listener?.({ type: 'stage', stage: 'starting', message: 'Starting proj…' });
		await new Promise((r) => setTimeout(r, 10));
		expect(lastFrame()).toContain('Starting proj…');
		expect(lastFrame()).not.toContain('Checking proj…');
		unmount();
	});
});

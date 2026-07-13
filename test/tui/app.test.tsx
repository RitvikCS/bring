import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/tui/App.js';

describe('App placeholder', () => {
	it('renders the version and a pointer to --help', () => {
		const { lastFrame, unmount } = render(<App version="9.9.9" />);
		const frame = lastFrame();
		expect(frame).toContain('bring');
		expect(frame).toContain('9.9.9');
		expect(frame).toContain('bring --help');
		unmount();
	});
});

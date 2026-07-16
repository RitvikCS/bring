import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { AppView } from '../../src/tui/App.js';
import { INITIAL_STATE, reduce } from '../../src/tui/state.js';
import { makeContainer, makeWorkspace } from '../helpers/tui-fixtures.js';

// Regression guard for frame geometry: no rendered line may ever exceed
// the terminal width, and every content row must close with a border
// character on the right — at ANY width. (An open right edge on a real
// terminal therefore indicates a terminal-size reporting race, not a
// layout bug; see the resize repaint in cli.tsx.)

describe('frame geometry', () => {
	it('never overflows and always closes the right border, across widths', () => {
		const state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [{ ...makeWorkspace('Leetcode-Solutions', 'not-created') }],
			dotfilesRepository: 'https://github.com/RitvikCS/devcon-dotfiles.git',
		});
		for (const columns of [90, 91, 95, 99, 100, 101, 105, 117, 121, 133, 140]) {
			const instance = render(
				<AppView state={state} size={{ columns, rows: 24 }} version="0.0.0" />,
			);
			const frame = instance.lastFrame() ?? '';
			instance.unmount();
			const lines = frame.split('\n');
			const overflowing = lines.filter((l) => stringWidth(l) > columns);
			expect(overflowing, `overflow at ${columns} cols`).toEqual([]);
			const contentRows = lines.slice(1, -2);
			const openRows = contentRows.filter(
				(l) => !/[│╮╯╭╰]\s*$/.test(l.trimEnd()),
			);
			expect(openRows, `open right border at ${columns} cols`).toEqual([]);
		}
	});

	it('keeps both Containers panes inside every wide frame', () => {
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [],
			resources: {
				containers: [
					makeContainer(
						'a-very-long-container-name-that-must-truncate',
						'running',
						'a-very-long-workspace-name',
					),
				],
				images: [],
				refreshedAt: '',
			},
		});
		state = reduce(state, { type: 'move-section', delta: 1 });
		for (const columns of [90, 91, 99, 100, 117, 121, 140]) {
			const instance = render(
				<AppView state={state} size={{ columns, rows: 24 }} version="0.0.0" />,
			);
			const lines = (instance.lastFrame() ?? '').split('\n');
			instance.unmount();
			expect(
				lines.filter((line) => stringWidth(line) > columns),
				`overflow at ${columns} cols`,
			).toEqual([]);
			const openRows = lines
				.slice(1, -2)
				.filter((line) => !/[│╮╯╭╰]\s*$/.test(line.trimEnd()));
			expect(openRows, `open right border at ${columns} cols`).toEqual([]);
		}
	});
});

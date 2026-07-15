// Layout math (spec §11.4), kept out of components so tests can pin sizes.

export interface Size {
	columns: number;
	rows: number;
}

export type LayoutMode = 'wide' | 'narrow' | 'too-small';

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 18;
const WIDE_THRESHOLD = 90;

export function layoutMode(size: Size): LayoutMode {
	if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
		return 'too-small';
	}
	return size.columns >= WIDE_THRESHOLD ? 'wide' : 'narrow';
}

/** Left pane ≈ 30–35% of a wide terminal (spec §11.4). */
export function listPaneWidth(size: Size): number {
	return Math.min(Math.max(Math.round(size.columns * 0.32), 24), 40);
}

/** Rows inside a content pane: header + status bar + pane borders. */
export function contentRows(size: Size): number {
	return Math.max(size.rows - 4, 3);
}

/** Log lines visible at once: content minus title, spacer, and footer. */
export function logVisibleRows(size: Size): number {
	return Math.max(contentRows(size) - 3, 1);
}

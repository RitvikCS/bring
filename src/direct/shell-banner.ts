import { makePaint } from '../cli/ansi.js';

// The shell boundary markers. A container prompt can look identical to the
// host prompt (same dotfiles on both sides!), so entering and leaving a
// workspace shell each get one unmistakable accent-colored line.

export function enteringShellLine(name: string, color: boolean): string {
	const paint = makePaint(color);
	return `${paint('cyan', '▶')} ${paint('bold', name)} ${paint(
		'dim',
		'· container shell — exit or Ctrl-D returns',
	)}`;
}

export function leftShellLine(
	name: string,
	color: boolean,
	exitCode?: number,
): string {
	const paint = makePaint(color);
	const code =
		exitCode !== undefined && exitCode !== 0 ? ` · exit ${exitCode}` : '';
	return `${paint('cyan', '◀')} ${paint('bold', name)} ${paint(
		'dim',
		`· back on your machine${code}`,
	)}`;
}

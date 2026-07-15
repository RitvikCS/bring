import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/application/doctor.js';
import { App, AppView } from '../../src/tui/App.js';
import type { TuiEnvironment } from '../../src/tui/load.js';
import {
	INITIAL_STATE,
	reduce,
	type TuiAction,
	type TuiState,
	type TuiWorkspace,
} from '../../src/tui/state.js';
import { makeWorkspace } from '../helpers/tui-fixtures.js';

// Frame tests at pinned sizes (P1-33/34/36/37/39/40/41/43). Input
// simulation through fake stdin is unreliable on Ink 7, so behavior is
// covered by the keymap/reducer tests and these assert the rendering of
// crafted states — plus full-App tests for the async loading flow.

const WIDE = { columns: 100, rows: 30 };
const NARROW = { columns: 80, rows: 24 };

function stateFrom(actions: TuiAction[], base: TuiState = INITIAL_STATE) {
	return actions.reduce(reduce, base);
}

function ready(workspaces: TuiWorkspace[]): TuiState {
	return stateFrom([{ type: 'loaded', workspaces }]);
}

function view(state: TuiState, size = WIDE) {
	const instance = render(
		<AppView state={state} size={size} version="1.0.0" />,
	);
	const frame = instance.lastFrame() ?? '';
	instance.unmount();
	return frame;
}

const HEALTHY: DoctorReport = { healthy: true, checks: [] };

function fakeEnvironment(overrides: Partial<TuiEnvironment>): TuiEnvironment {
	return {
		doctor: () => Promise.resolve(HEALTHY),
		loadWorkspaces: () => Promise.resolve([]),
		up: () => Promise.reject(new Error('not in this test')),
		down: () => Promise.reject(new Error('not in this test')),
		shell: () => Promise.reject(new Error('not in this test')),
		readLog: () => null,
		dotfilesDefault: () => null,
		...overrides,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('sizing (§11.4)', () => {
	it('shows the too-small message under 60×18', () => {
		const frame = view(ready([makeWorkspace('a', 'running')]), {
			columns: 50,
			rows: 15,
		});
		expect(frame).toContain('at least 60 columns × 18 rows');
		expect(frame).toContain('bring . up');
	});

	it('renders two panes at 100 columns', () => {
		const frame = view(ready([makeWorkspace('ml-platform', 'running')]));
		expect(frame).toContain('WORKSPACES');
		expect(frame).toContain('● ml-platform');
		expect(frame).toContain('Status');
		expect(frame).toContain('8000 → localhost:8000');
		expect(frame).toContain('[e] Shell');
	});

	it('renders only the list at 80 columns, detail after open-detail', () => {
		const state = ready([makeWorkspace('ml-platform', 'running')]);
		const listFrame = view(state, NARROW);
		expect(listFrame).toContain('● ml-platform');
		expect(listFrame).not.toContain('[e] Shell');

		const detailFrame = view(
			stateFrom([{ type: 'open-detail' }], state),
			NARROW,
		);
		expect(detailFrame).toContain('[e] Shell');
	});
});

describe('chrome', () => {
	it('shows the tab bar, version, and key hints', () => {
		const frame = view(ready([makeWorkspace('a', 'running')]));
		expect(frame).toContain('bring');
		expect(frame).toContain('Workspaces');
		expect(frame).toContain('Containers');
		expect(frame).toContain('1.0.0');
		expect(frame).toContain('? help');
		expect(frame).toContain('q quit');
	});

	it('renders a placeholder for Phase 2 sections', () => {
		const frame = view(
			stateFrom(
				[{ type: 'move-section', delta: 1 }],
				ready([makeWorkspace('a', 'running')]),
			),
		);
		expect(frame).toContain('arrives in a later phase');
	});
});

describe('detail variants (§12.1, §12.3)', () => {
	it('missing-config lists the searched locations', () => {
		const frame = view(ready([makeWorkspace('portfolio', 'missing-config')]));
		expect(frame).toContain('! Configuration missing');
		expect(frame).toContain('.devcontainer/devcontainer.json');
		expect(frame).toContain('[r] Check again');
	});

	it('not-created explains and offers up', () => {
		const frame = view(ready([makeWorkspace('fresh', 'not-created')]));
		expect(frame).toContain('Never built');
		expect(frame).toContain('[u] Up');
	});

	it('marks an unregistered current-folder workspace in the list', () => {
		const frame = view(
			ready([{ ...makeWorkspace('fresh', 'not-created'), unregistered: true }]),
		);
		expect(frame).toContain('fresh (this folder)');
	});

	it('shows the remembered dotfiles default when one is set (A6)', () => {
		const state = stateFrom([
			{
				type: 'loaded',
				workspaces: [makeWorkspace('a', 'running')],
				dotfilesRepository: 'https://github.com/u/dotfiles',
			},
		]);
		const frame = view(state);
		expect(frame).toContain('Dotfiles');
		expect(frame).toContain('https://github.com/u/dotfiles');
		expect(frame).toContain('(user default)');
	});

	it('failed shows the concise problem and the log action', () => {
		const base = ready([makeWorkspace('broken', 'stopped')]);
		const state = stateFrom(
			[
				{
					type: 'operation-started',
					operation: 'up',
					workspace: makeWorkspace('broken', 'stopped'),
				},
				{
					type: 'operation-completed',
					result: {
						operation: 'up',
						outcome: 'failed',
						workspace: '/home/user/broken',
						workspaceName: 'broken',
						message: 'postCreateCommand failed',
						durationMs: 900,
						containerIds: [],
						problem: {
							code: 'DEVCONTAINER_FAILED',
							summary: 'postCreateCommand failed',
							remedy: 'bring broken logs',
						},
					},
				},
				{ type: 'dismiss-operation' },
			],
			base,
		);
		const frame = view(state);
		expect(frame).toContain('! postCreateCommand failed');
		expect(frame).toContain('[L] Logs');
	});
});

describe('operation pane (§12.2)', () => {
	const start: TuiAction[] = [
		{
			type: 'operation-started',
			operation: 'rebuild',
			workspace: makeWorkspace('ml', 'running'),
		},
		{ type: 'operation-stage', stage: 'validating', message: 'Checking ml…' },
		{ type: 'operation-stage', stage: 'building', message: 'Rebuilding ml…' },
		{ type: 'operation-output', chunk: 'Step 5/9 : RUN pip install\n' },
	];

	it('shows completed stages, the live stage, and the latest output', () => {
		const frame = view(
			stateFrom(start, ready([makeWorkspace('ml', 'running')])),
		);
		expect(frame).toContain('✓ Checking ml…');
		expect(frame).toContain('Rebuilding ml…');
		expect(frame).toContain('Current: Step 5/9 : RUN pip install');
		expect(frame).toContain('[L] Show captured output');
	});

	it('a settled failure shows the outcome and dismissal hint', () => {
		const state = stateFrom(
			[
				...start,
				{
					type: 'operation-completed',
					result: {
						operation: 'rebuild',
						outcome: 'failed',
						workspace: '/home/user/ml',
						workspaceName: 'ml',
						message: 'build failed',
						durationMs: 4000,
						containerIds: [],
					},
				},
			],
			ready([makeWorkspace('ml', 'running')]),
		);
		const frame = view(state);
		expect(frame).toContain('✗ build failed');
		expect(frame).toContain('[Enter] Continue');
	});
});

describe('modals (P1-40)', () => {
	it('help overlay lists the bindings', () => {
		const frame = view(
			stateFrom(
				[{ type: 'open-help' }],
				ready([makeWorkspace('a', 'running')]),
			),
		);
		expect(frame).toContain('Keyboard help');
		expect(frame).toContain('removal confirmation');
	});

	it('remove confirmation states that source files stay', () => {
		const frame = view(
			stateFrom(
				[{ type: 'open-confirm-remove' }],
				ready([makeWorkspace('a', 'running')]),
			),
		);
		expect(frame).toContain('Remove a?');
		expect(frame).toContain('Source files are not touched.');
		expect(frame).toContain('[Enter] Remove');
		expect(frame).toContain('[Esc] Cancel');
	});
});

describe('log view (P1-41)', () => {
	it('windows the lines and reports the position', () => {
		const content = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join(
			'\n',
		);
		const state = stateFrom(
			[{ type: 'open-logs', workspaceName: 'ml', content }],
			ready([makeWorkspace('ml', 'running')]),
		);
		const frame = view(state, NARROW);
		expect(frame).toContain('ml');
		expect(frame).toContain('latest log');
		expect(frame).toContain('line-1');
		expect(frame).toContain('of 40');
		expect(frame).not.toContain('line-40');
	});
});

describe('full App loading flow', () => {
	it('loads workspaces after a healthy doctor run', async () => {
		const environment = fakeEnvironment({
			loadWorkspaces: () =>
				Promise.resolve([makeWorkspace('ml-platform', 'running')]),
		});
		const instance = render(
			<App environment={environment} version="1.0.0" sizeOverride={WIDE} />,
		);
		await tick();
		expect(instance.lastFrame()).toContain('● ml-platform');
		instance.unmount();
	});

	it('shows the doctor-blocked screen when unhealthy (P1-43)', async () => {
		const report: DoctorReport = {
			healthy: false,
			checks: [
				{
					id: 'docker-daemon',
					label: 'Docker daemon',
					status: 'failed',
					detail: 'unreachable · context default',
					problem: {
						code: 'DEPENDENCY_UNREACHABLE',
						summary: 'Docker is installed, but Bring cannot reach the daemon.',
						remedy: 'Start Docker, then run: bring doctor',
					},
				},
			],
		};
		const environment = fakeEnvironment({
			doctor: () => Promise.resolve(report),
		});
		const instance = render(
			<App environment={environment} version="1.0.0" sizeOverride={WIDE} />,
		);
		await tick();
		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain("Bring can't start yet");
		expect(frame).toContain('✗');
		expect(frame).toContain('Docker daemon');
		expect(frame).toContain('Fix: Start Docker, then run: bring doctor');
		expect(frame).toContain('[r] Check again');
		instance.unmount();
	});

	it('renders the empty-registry hint when no workspaces exist', async () => {
		const instance = render(
			<App
				environment={fakeEnvironment({})}
				version="1.0.0"
				sizeOverride={WIDE}
			/>,
		);
		await tick();
		expect(instance.lastFrame()).toContain('None yet');
		instance.unmount();
	});
});

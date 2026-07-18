import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/application/doctor.js';
import { App, AppView } from '../../src/tui/App.js';
import { formatBytes } from '../../src/tui/ImagesPane.js';
import type { TuiEnvironment } from '../../src/tui/load.js';
import {
	INITIAL_STATE,
	reduce,
	type TuiAction,
	type TuiState,
	type TuiWorkspace,
} from '../../src/tui/state.js';
import {
	makeContainer,
	makeImage,
	makeWorkspace,
} from '../helpers/tui-fixtures.js';

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
		load: () =>
			Promise.resolve({
				workspaces: [],
				resources: { containers: [], images: [], refreshedAt: '' },
				resourceProblem: null,
				dotfilesRepository: null,
			}),
		up: () => Promise.reject(new Error('not in this test')),
		down: () => Promise.reject(new Error('not in this test')),
		shell: () => Promise.reject(new Error('not in this test')),
		containerShell: () => Promise.reject(new Error('not in this test')),
		mutateContainer: () => Promise.reject(new Error('not in this test')),
		removeImages: () => Promise.reject(new Error('not in this test')),
		readLog: () => null,
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

	it('renders a useful empty state in Containers and placeholders for later sections', () => {
		const frame = view(
			stateFrom(
				[{ type: 'move-section', delta: 1 }],
				ready([makeWorkspace('a', 'running')]),
			),
		);
		expect(frame).toContain('No Dev Container resources');
		expect(frame).toContain('positively identified');
		const profiles = view(
			stateFrom(
				[{ type: 'move-section', delta: 1 }],
				stateFrom(
					[{ type: 'move-section', delta: 1 }],
					stateFrom(
						[{ type: 'move-section', delta: 1 }],
						ready([makeWorkspace('a', 'running')]),
					),
				),
			),
		);
		expect(profiles).toContain('arrives in a later phase');
	});
});

describe('Containers section (§12.4/§12.5)', () => {
	function containersState() {
		return stateFrom([
			{
				type: 'loaded',
				workspaces: [],
				resources: {
					containers: [makeContainer('project-dev', 'running', 'project')],
					images: [],
					refreshedAt: '',
				},
			},
			{ type: 'move-section', delta: 1 },
		]);
	}

	it('shows the resource list and detail together when wide', () => {
		const frame = view(containersState());
		expect(frame).toContain('CONTAINERS 1/1');
		expect(frame).toContain('● project-dev · project');
		expect(frame).toContain('primary devcontainer');
		expect(frame).toContain('8000 → localhost:8000');
	});

	it('uses list then detail drill-down in a narrow terminal', () => {
		const state = containersState();
		const list = view(state, NARROW);
		expect(list).toContain('● project-dev · project');
		expect(list).not.toContain('primary devcontainer');
		const detail = view(stateFrom([{ type: 'open-detail' }], state), NARROW);
		expect(detail).toContain('primary devcontainer');
	});
});

describe('Images section (§12.6)', () => {
	function imagesState() {
		return stateFrom([
			{
				type: 'loaded',
				workspaces: [],
				resources: {
					containers: [],
					images: [makeImage('base', true), makeImage('unused')],
					refreshedAt: '',
				},
			},
			{ type: 'move-section', delta: 1 },
			{ type: 'move-section', delta: 1 },
		]);
	}

	it('shows size, usage, impact, and selection state in wide mode', () => {
		const frame = view(imagesState());
		expect(frame).toContain('IMAGES 1/2 · 0 selected');
		expect(frame).toContain('base:latest');
		expect(frame).toContain('● Attached');
		expect(frame).toContain('Attached containers');
		expect(frame).toContain('Workspace impact');
	});

	it('uses list/detail drill-down when narrow', () => {
		const state = imagesState();
		expect(view(state, NARROW)).not.toContain('Attached containers');
		expect(view(stateFrom([{ type: 'open-detail' }], state), NARROW)).toContain(
			'Attached containers',
		);
	});

	it('distinguishes cached bases and warns on explicit removal', () => {
		let state = stateFrom([
			{
				type: 'loaded',
				workspaces: [],
				resources: {
					containers: [],
					images: [makeImage('ubuntu', 'base')],
					refreshedAt: '',
				},
			},
			{ type: 'move-section', delta: 1 },
			{ type: 'move-section', delta: 1 },
		]);
		const detail = view(state);
		expect(detail).toContain('◆ Cached base');
		expect(detail).toContain('Descendant containers');

		state = stateFrom(
			[
				{ type: 'toggle-image-selection' },
				{ type: 'open-confirm-image-remove' },
			],
			state,
		);
		const confirmation = view(state);
		expect(confirmation).toContain('1 cached base image');
		expect(confirmation).toContain('may need to be pulled or rebuilt again');
		expect(confirmation).toContain('Affected workspaces may rebuild: ubuntu');
	});

	it('renders one batch confirmation with an upper-bound disclaimer', () => {
		let state = imagesState();
		state = stateFrom(
			[
				{ type: 'move-selection', delta: 1 },
				{ type: 'toggle-image-selection' },
				{ type: 'open-confirm-image-remove' },
			],
			state,
		);
		const frame = view(state);
		expect(frame).toContain('Remove 1 image?');
		expect(frame).toContain('Up to 1.0 GB may be recovered.');
		expect(frame).toContain('• unused:latest');
		expect(frame).toContain('actual recovery may be lower');
		expect(frame).toContain(
			'Existing containers, volumes, and source files are not touched.',
		);
	});

	it('formats exact byte sizes with compact decimal units', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1250)).toBe('1.3 kB');
		expect(formatBytes(2_730_000_000)).toBe('2.7 GB');
	});

	it('shows a live filter prompt and match count', () => {
		let state = imagesState();
		state = stateFrom(
			[{ type: 'open-filter' }, { type: 'filter-input', text: 'unused' }],
			state,
		);
		const frame = view(state);
		expect(frame).toContain('1/1 · 0 selected · 1/2 match');
		expect(frame).toContain('Filter /unused');
		expect(frame).toContain('Filter Images: /unused█');
		expect(frame).toContain('Enter apply');
		expect(frame).toContain('Esc cancel');
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

	it('shows container age, last-used time, and a log tail when known', () => {
		const workspace: TuiWorkspace = {
			...makeWorkspace('ml', 'running'),
			uptimeText: 'Up 2 hours',
			lastUsedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
			logTail: ['Step 5/9 : RUN pip install', 'done.'],
		};
		const frame = view(ready([workspace]));
		expect(frame).toContain('Container');
		expect(frame).toContain('Up 2 hours');
		expect(frame).toContain('Last used');
		expect(frame).toContain('3 minutes ago');
		expect(frame).toContain('Latest log');
		expect(frame).toContain('Step 5/9 : RUN pip install');
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
		expect(frame).toContain('confirmed removal');
		expect(frame).toContain('filter Containers or Images');
	});

	it('rebuild confirmation warns about the cost before anything runs', () => {
		const frame = view(
			stateFrom(
				[{ type: 'open-confirm-rebuild' }],
				ready([makeWorkspace('a', 'running')]),
			),
		);
		expect(frame).toContain('Rebuild a?');
		expect(frame).toContain('deleted and rebuilt');
		expect(frame).toContain('[Enter] Rebuild');
		expect(frame).toContain('[Esc] Cancel');
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

	it('container removal names the exact resource and preservation boundary', () => {
		const state = stateFrom([
			{
				type: 'loaded',
				workspaces: [],
				resources: {
					containers: [makeContainer('project-dev')],
					images: [],
					refreshedAt: '',
				},
			},
			{ type: 'move-section', delta: 1 },
			{ type: 'open-confirm-container-remove' },
		]);
		const frame = view(state);
		expect(frame).toContain('Remove project-dev?');
		expect(frame).toContain(
			'Images, volumes, and source files are not touched.',
		);
		expect(frame).toContain('[Enter] Remove');
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
			load: () =>
				Promise.resolve({
					workspaces: [makeWorkspace('ml-platform', 'running')],
					resources: { containers: [], images: [], refreshedAt: '' },
					resourceProblem: null,
					dotfilesRepository: null,
				}),
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

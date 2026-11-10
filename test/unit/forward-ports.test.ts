import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { afterEach, it as baseIt, describe, expect, it } from 'vitest';
import {
	bridgeArgv,
	bridgesForFileLimit,
	explainConnectionFailure,
	type ForwardEvent,
	type Forwarding,
	type ForwardSpec,
	HELPERS,
	type Helper,
	MAX_BRIDGES,
	PROBE_SCRIPT,
	parsePortSpec,
	resolveSpecs,
	spawnBridge,
	startForwarding,
} from '../../src/application/forward-ports.js';
import {
	extractForwardPorts,
	interpretProbe,
} from '../../src/cli/run-forward.js';

describe('parsePortSpec', () => {
	it.each([
		[5173, { hostPort: 5173, targetHost: '127.0.0.1', targetPort: 5173 }],
		['5173', { hostPort: 5173, targetHost: '127.0.0.1', targetPort: 5173 }],
		[
			'8080:3000',
			{ hostPort: 8080, targetHost: '127.0.0.1', targetPort: 3000 },
		],
		['db:5432', { hostPort: 5432, targetHost: 'db', targetPort: 5432 }],
		['15432:db:5432', { hostPort: 15432, targetHost: 'db', targetPort: 5432 }],
	])('parses %j', (token, spec) => {
		expect(parsePortSpec(token)).toEqual(spec);
	});

	it.each([
		['0'],
		['70000'],
		['abc'],
		['1:2:3:4'],
		['db:'],
		['-1'],
		['a b:80'],
		['$(x):80'],
	])('rejects %j', (token) => {
		expect(parsePortSpec(token)).toHaveProperty('error');
	});
});

describe('explainConnectionFailure', () => {
	const spec: ForwardSpec = {
		hostPort: 1,
		targetHost: '127.0.0.1',
		targetPort: 5173,
	};
	it('turns refused connections into a "not up yet" line', () => {
		expect(
			explainConnectionFailure(
				'bash: connect: Connection refused',
				spec,
				'api',
			),
		).toBe('nothing is listening on port 5173 inside api yet');
	});
	it('explains a replaced container after a rebuild', () => {
		expect(
			explainConnectionFailure(
				'Error response from daemon: No such container: abc',
				spec,
				'api',
			),
		).toContain('replaced or removed');
	});
	it('recognises a stopped container', () => {
		expect(
			explainConnectionFailure(
				'Error response from daemon: container abc is not running',
				spec,
				'api',
			),
		).toBe('api is not running');
	});
});

// The bridges below run for real on this machine — the same argv bring runs
// inside the container, minus `docker exec -i <id>`. Detached, because the
// bash bridge ends with `kill 0` (its own process group, as under exec).
function hasCommand(name: string): boolean {
	return spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}

const open: Forwarding[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const f of open.splice(0)) {
		await f.close();
	}
	for (const s of servers.splice(0)) {
		s.close();
	}
});

async function httpServer(body: string, host = '127.0.0.1'): Promise<number> {
	const server = createServer((_req, res) => {
		res.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
	const probe = createNetServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

function localBridge(helper: Helper) {
	const spawned: ChildProcessWithoutNullStreams[] = [];
	const openBridge = async (spec: ForwardSpec) => {
		const [cmd, ...args] = bridgeArgv(helper, spec.targetHost, spec.targetPort);
		const child = spawn(cmd as string, args, { detached: true });
		spawned.push(child);
		return child;
	};
	return { openBridge, spawned };
}

async function forward(
	helper: Helper,
	targetPort: number,
	events: ForwardEvent[] = [],
) {
	const hostPort = await freePort();
	const bridge = localBridge(helper);
	const f = await startForwarding({
		specs: [{ hostPort, targetHost: '127.0.0.1', targetPort }],
		openBridge: bridge.openBridge,
		onEvent: (e) => events.push(e),
		bridgeGraceMs: 300,
	});
	open.push(f);
	return { hostPort, bridge, f, events };
}

const exited = (child: ChildProcessWithoutNullStreams) =>
	child.exitCode !== null || child.signalCode !== null;

describe.each([
	'bash',
	'node',
] as const)('startForwarding via the %s bridge', (helper) => {
	// Skipped — visibly — where the helper is not installed.
	const it = hasCommand(helper) ? baseIt : baseIt.skip;
	it('serves HTTP through the bridge and the bridge exits afterwards', async () => {
		const target = await httpServer('hello from the container');
		const { hostPort, bridge } = await forward(helper, target);
		for (let i = 0; i < 3; i++) {
			const res = await fetch(`http://127.0.0.1:${hostPort}/`, {
				headers: { connection: 'close' },
			});
			expect(await res.text()).toBe('hello from the container');
		}
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(bridge.spawned.length).toBeGreaterThanOrEqual(3);
		expect(bridge.spawned.every(exited)).toBe(true);
	});

	it('delivers the reply to a client that stops sending first (half-close)', async () => {
		// Replies 300 ms after the request, then closes. allowHalfOpen: like a
		// real server that supports it, keep the socket writable after the
		// client's end-of-input (the node bridge passes that on).
		const slow = createNetServer({ allowHalfOpen: true }, (c) => {
			c.once('data', () => {
				setTimeout(() => c.end('late reply'), 300);
			});
			c.on('error', () => {});
		});
		await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
		const target = (slow.address() as AddressInfo).port;
		const { hostPort } = await forward(helper, target);
		const { connect } = await import('node:net');
		const started = Date.now();
		const reply = await new Promise<string>((resolve) => {
			let text = '';
			const client = connect({
				port: hostPort,
				host: '127.0.0.1',
				allowHalfOpen: true,
			});
			client.on('data', (d) => {
				text += d.toString();
			});
			client.on('close', () => resolve(text));
			client.end('request');
		});
		slow.close();
		expect(reply).toBe('late reply');
		// The bridge ends as soon as the server closes — it does not sit out
		// the linger.
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('reports a refused connection without stopping the forwarder', async () => {
		const dead = await freePort();
		const { hostPort, events } = await forward(helper, dead);
		await fetch(`http://127.0.0.1:${hostPort}/`).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const failed = events.find((e) => e.type === 'connection-failed');
		expect(failed?.type === 'connection-failed' && failed.message).toMatch(
			/refused/i,
		);
	});
});

describe('startForwarding', () => {
	it('binds 127.0.0.1 only', async () => {
		const target = await httpServer('x');
		const { f } = await forward('node', target);
		expect(f.listening).toHaveLength(1);
		const res = await fetch(`http://127.0.0.1:${f.listening[0]?.hostPort}/`);
		expect(await res.text()).toBe('x');
		// Not reachable on any other interface address of this machine.
		const { networkInterfaces } = await import('node:os');
		const external = Object.values(networkInterfaces())
			.flat()
			.find((i) => i && i.family === 'IPv4' && !i.internal);
		if (external) {
			await expect(
				fetch(`http://${external.address}:${f.listening[0]?.hostPort}/`, {
					signal: AbortSignal.timeout(1000),
				}),
			).rejects.toThrow();
		}
	});

	it('skips a port that is taken and keeps the others', async () => {
		const taken = await httpServer('occupant');
		const target = await httpServer('ok');
		const free = await freePort();
		const events: ForwardEvent[] = [];
		const f = await startForwarding({
			specs: [
				{ hostPort: taken, targetHost: '127.0.0.1', targetPort: target },
				{ hostPort: free, targetHost: '127.0.0.1', targetPort: target },
			],
			openBridge: localBridge('node').openBridge,
			onEvent: (e) => events.push(e),
		});
		open.push(f);
		expect(events[0]).toMatchObject({
			type: 'listen-failed',
			code: 'EADDRINUSE',
		});
		expect(f.listening.map((s) => s.hostPort)).toEqual([free]);
	});

	it('closes cleanly with a connection still open', async () => {
		const target = await httpServer('x');
		const { hostPort, bridge, f } = await forward('node', target);
		const { connect } = await import('node:net');
		const socket = connect(hostPort, '127.0.0.1');
		await new Promise((resolve) => socket.once('connect', resolve));
		await new Promise((resolve) => setTimeout(resolve, 300));
		await f.close();
		open.splice(open.indexOf(f), 1);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(bridge.spawned.every(exited)).toBe(true);
		socket.destroy();
	});
});

describe('resolveSpecs', () => {
	it('drops exact repeats', () => {
		expect(resolveSpecs(['5173', 5173, '5173:5173'])).toEqual({
			ok: true,
			specs: [{ hostPort: 5173, targetHost: '127.0.0.1', targetPort: 5173 }],
		});
	});

	it('refuses two different targets on one local port, with a way out', () => {
		const result = resolveSpecs(['5432', 'db:5432']);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('asked for twice');
		expect(!result.ok && result.error).toContain('5433:db:5432');
	});

	it('reports the first bad token', () => {
		expect(resolveSpecs(['5173', 'nope'])).toMatchObject({
			ok: false,
			error: expect.stringContaining('`nope` is not a port'),
		});
	});
});

describe('helper probe', () => {
	it('prefers bash, then node, then socat', () => {
		expect([...HELPERS]).toEqual(['bash', 'node', 'socat']);
		expect(PROBE_SCRIPT).toContain('for h in bash node socat;');
	});

	it.runIf(hasCommand('sh'))(
		'the probe script really finds a helper here',
		() => {
			const run = spawnSync('sh', ['-c', PROBE_SCRIPT]);
			expect(interpretProbe(run.status ?? -1, String(run.stdout), '')).toEqual({
				outcome: 'found',
				helper: HELPERS.find((h) => hasCommand(h)),
			});
		},
	);

	it('tells "none installed" apart from a failed check', () => {
		expect(interpretProbe(0, 'bash\n', '')).toEqual({
			outcome: 'found',
			helper: 'bash',
		});
		expect(interpretProbe(1, '', '')).toEqual({ outcome: 'none' });
		expect(
			interpretProbe(
				1,
				'',
				'Error response from daemon: container x is not running',
			),
		).toMatchObject({ outcome: 'failed' });
		expect(interpretProbe(126, '', 'exec failed: sh: not found')).toEqual({
			outcome: 'failed',
			message: 'exec failed: sh: not found',
		});
		expect(interpretProbe(0, 'zsh\n', '')).toMatchObject({ outcome: 'failed' });
	});
});

describe('extractForwardPorts', () => {
	it('reads the merged list, falling back to the plain configuration', () => {
		expect(
			extractForwardPorts(
				'noise\n{"configuration":{"forwardPorts":[1]},"mergedConfiguration":{"forwardPorts":[5173,"db:5432"]}}\n',
			),
		).toEqual(['5173', 'db:5432']);
		expect(
			extractForwardPorts('{"configuration":{"forwardPorts":[8000]}}'),
		).toEqual(['8000']);
	});

	it('returns [] when there are none and null when the output is not JSON', () => {
		expect(extractForwardPorts('{"configuration":{}}')).toEqual([]);
		expect(extractForwardPorts('error: something')).toBeNull();
		expect(extractForwardPorts('{broken')).toBeNull();
	});
});

describe('startForwarding under failure and load', () => {
	it('survives a bridge that cannot be spawned', async () => {
		const events: ForwardEvent[] = [];
		const hostPort = await freePort();
		const f = await startForwarding({
			specs: [{ hostPort, targetHost: '127.0.0.1', targetPort: 1 }],
			openBridge: async () => spawnBridge('/nonexistent/bring-bridge', []),
			onEvent: (e) => events.push(e),
		});
		open.push(f);
		for (let i = 0; i < 3; i++) {
			await fetch(`http://127.0.0.1:${hostPort}/`).catch(() => undefined);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(events.filter((e) => e.type === 'connection-failed')).toHaveLength(
			3,
		);
		expect(f.listening).toHaveLength(1);
	});

	it('never runs more bridges at once than the cap, and still serves everyone', async () => {
		const target = await httpServer('ok');
		const hostPort = await freePort();
		let alive = 0;
		let peak = 0;
		const f = await startForwarding({
			specs: [{ hostPort, targetHost: '127.0.0.1', targetPort: target }],
			openBridge: async (spec) => {
				const [cmd, ...args] = bridgeArgv(
					'node',
					spec.targetHost,
					spec.targetPort,
				);
				const child = spawnBridge(cmd as string, args);
				alive++;
				peak = Math.max(peak, alive);
				child.on('close', () => {
					alive--;
				});
				return child;
			},
			onEvent: () => {},
			maxBridges: 2,
			bridgeGraceMs: 300,
		});
		open.push(f);
		const bodies = await Promise.all(
			Array.from({ length: 8 }, async () => {
				const res = await fetch(`http://127.0.0.1:${hostPort}/`, {
					headers: { connection: 'close' },
				});
				return res.text();
			}),
		);
		expect(bodies).toEqual(Array(8).fill('ok'));
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe('running out of file handles', () => {
	it('makes the connection wait for a free bridge instead of dropping it', async () => {
		const target = await httpServer('ok');
		const hostPort = await freePort();
		const events: ForwardEvent[] = [];
		let alive = 0;
		const f = await startForwarding({
			specs: [{ hostPort, targetHost: '127.0.0.1', targetPort: target }],
			// Pretend the machine can hold two bridges: a third spawn fails
			// the way Node reports EMFILE.
			openBridge: async (spec) => {
				if (alive >= 2) {
					const dud = spawnBridge('/nonexistent/bring-bridge', []);
					dud.once('error', (error) => {
						(error as NodeJS.ErrnoException).code = 'EMFILE';
					});
					return dud;
				}
				const [cmd, ...args] = bridgeArgv(
					'node',
					spec.targetHost,
					spec.targetPort,
				);
				const child = spawnBridge(cmd as string, args);
				alive++;
				child.on('close', () => {
					alive--;
				});
				return child;
			},
			onEvent: (e) => events.push(e),
			bridgeGraceMs: 300,
		});
		open.push(f);
		const bodies = await Promise.all(
			Array.from({ length: 8 }, async () => {
				const res = await fetch(`http://127.0.0.1:${hostPort}/`, {
					headers: { connection: 'close' },
				});
				return res.text();
			}),
		);
		expect(bodies).toEqual(Array(8).fill('ok'));
		expect(events.filter((e) => e.type === 'connection-failed')).toEqual([]);
	});
});

describe('bridgesForFileLimit', () => {
	it.each([
		[undefined, MAX_BRIDGES],
		[Number.POSITIVE_INFINITY, MAX_BRIDGES],
		[1_048_576, MAX_BRIDGES],
		[1024, MAX_BRIDGES],
		[256, 36], // macOS default
		[80, 6],
		[16, 2],
	])('ulimit -n %j → %i bridges', (limit, bridges) => {
		expect(bridgesForFileLimit(limit)).toBe(bridges);
	});

	it('names the cause when file handles run out', () => {
		expect(
			explainConnectionFailure(
				'spawn /usr/bin/docker EMFILE',
				{ hostPort: 1, targetHost: '127.0.0.1', targetPort: 5173 },
				'api',
			),
		).toContain('ran out of file handles');
	});
});

import {
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
	spawn,
} from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';

// `bring forward` (P4 §3a, DD-7): make devcontainer.json `forwardPorts`
// work outside VS Code. One host listener per port, bound to 127.0.0.1
// only; each accepted connection gets its own stdio bridge into the
// container (`docker exec -i <id> <helper>`), and the helper dials the
// port from INSIDE the container's network namespace — so servers bound to
// 127.0.0.1 in the container (Vite's default) are reachable, which a
// published `appPort` cannot do.

export interface ForwardSpec {
	hostPort: number;
	/** Host to dial inside the container: 127.0.0.1, or a Compose service. */
	targetHost: string;
	targetPort: number;
}

/**
 * `5173` · `8080:3000` (host:container) · `db:5432` (Compose service; host
 * port = service port) · `15432:db:5432`. Numbers come straight from
 * devcontainer.json `forwardPorts`.
 */
export function parsePortSpec(
	token: string | number,
): ForwardSpec | { error: string } {
	const text = String(token).trim();
	const parts = text.split(':');
	const port = (value: string | undefined): number | null => {
		if (value === undefined || !/^\d+$/.test(value)) {
			return null;
		}
		const n = Number(value);
		return n >= 1 && n <= 65535 ? n : null;
	};
	const hostName = (value: string | undefined): string | null =>
		value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
			? value
			: null;
	const invalid = {
		error: `\`${text}\` is not a port. Use 5173, 8080:3000 (yours:container's), or db:5432 (a Compose service).`,
	};

	if (parts.length === 1) {
		const p = port(parts[0]);
		return p === null
			? invalid
			: { hostPort: p, targetHost: '127.0.0.1', targetPort: p };
	}
	if (parts.length === 2) {
		const [a, b] = parts;
		const target = port(b);
		if (target === null) {
			return invalid;
		}
		const local = port(a);
		if (local !== null) {
			return { hostPort: local, targetHost: '127.0.0.1', targetPort: target };
		}
		const service = hostName(a);
		return service === null
			? invalid
			: { hostPort: target, targetHost: service, targetPort: target };
	}
	if (parts.length === 3) {
		const local = port(parts[0]);
		const service = hostName(parts[1]);
		const target = port(parts[2]);
		return local === null || service === null || target === null
			? invalid
			: { hostPort: local, targetHost: service, targetPort: target };
	}
	return invalid;
}

export function describeSpec(spec: ForwardSpec): string {
	const target =
		spec.targetHost === '127.0.0.1'
			? `${spec.targetPort}`
			: `${spec.targetHost}:${spec.targetPort}`;
	return `localhost:${spec.hostPort} → ${target}`;
}

/**
 * Bridge programs, in preference order. bash first: it is in nearly every
 * dev container image and ends the bridge the instant the server closes.
 * socat last: it waits 0.5s after either side closes, which adds 0.5s to
 * every response that ends by closing the connection (measured — e.g.
 * `python -m http.server`).
 */
export const HELPERS = ['bash', 'node', 'socat'] as const;
export type Helper = (typeof HELPERS)[number];

/** Prints the first available helper's name; exits 1 when there is none. */
export const PROBE_SCRIPT = `for h in ${HELPERS.join(' ')}; do command -v "$h" >/dev/null 2>&1 && { echo "$h"; exit 0; }; done; exit 1`;

/**
 * After the client stops sending, how long a bridge keeps waiting for the
 * server's reply before ending itself. Covers clients that half-close and
 * then read (`printf … | nc`); browsers and curl never rely on it.
 */
export const BRIDGE_LINGER_SECONDS = 3;

/**
 * The argv run inside the container for one connection: stdin → port,
 * port → stdout. Every variant ends ITSELF: at once when the server closes,
 * and within the linger after the client stops sending. It must, because a
 * docker exec killed from the host leaves the in-container process running
 * (verified for exec, P4 §1 V3). `kill 0` works because an exec'd process
 * leads its own process group (V4). node and socat pass the client's
 * end-of-input on to the server; bash cannot (no shutdown on /dev/tcp).
 */
export function bridgeArgv(
	helper: Helper,
	targetHost: string,
	targetPort: number,
): string[] {
	switch (helper) {
		case 'socat':
			return ['socat', '-', `TCP:${targetHost}:${targetPort}`];
		case 'bash':
			return [
				'bash',
				'-c',
				`exec 3<>"/dev/tcp/$0/$1" || exit 1; { cat <&3; kill 0; } & cat >&3; sleep ${BRIDGE_LINGER_SECONDS}; kill 0`,
				targetHost,
				String(targetPort),
			];
		case 'node':
			return [
				'node',
				'-e',
				[
					'const s=require("net").connect(+process.argv[2],process.argv[1]);',
					's.on("error",e=>{process.stderr.write(String(e.message)+"\\n");process.exit(1)});',
					'process.stdin.pipe(s);s.pipe(process.stdout);',
					's.on("close",()=>process.exit(0));',
					// After the client's end-of-input, leave once the server has
					// been silent for the linger; data restarts the wait.
					`let t;const arm=()=>{clearTimeout(t);t=setTimeout(()=>process.exit(0),${BRIDGE_LINGER_SECONDS * 1000})};`,
					'process.stdin.on("end",()=>{arm();s.on("data",arm)});',
				].join(''),
				targetHost,
				String(targetPort),
			];
	}
}

/**
 * Parse port tokens into specs, dropping exact repeats. Two different
 * targets on one local port cannot both be served.
 */
export function resolveSpecs(
	tokens: readonly (string | number)[],
): { ok: true; specs: ForwardSpec[] } | { ok: false; error: string } {
	const specs: ForwardSpec[] = [];
	for (const token of tokens) {
		const parsed = parsePortSpec(token);
		if ('error' in parsed) {
			return { ok: false, error: parsed.error };
		}
		const clash = specs.find((s) => s.hostPort === parsed.hostPort);
		if (clash === undefined) {
			specs.push(parsed);
		} else if (
			clash.targetHost !== parsed.targetHost ||
			clash.targetPort !== parsed.targetPort
		) {
			return {
				ok: false,
				error: `localhost:${parsed.hostPort} is asked for twice (${describeSpec(clash)} and ${describeSpec(parsed)}). Give one of them another local port, e.g. ${parsed.hostPort + 1}:${parsed.targetHost === '127.0.0.1' ? '' : `${parsed.targetHost}:`}${parsed.targetPort}.`,
			};
		}
	}
	return { ok: true, specs };
}

const spawnFailures = new WeakMap<ChildProcess, Error>();

/**
 * Spawn one bridge process. A failed spawn (no file handles left, binary
 * gone) is emitted as an `error` event on the next tick — before an async
 * caller can attach a listener, which would crash the whole forwarder. So
 * the failure is caught here and handed to startForwarding.
 */
export function spawnBridge(
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
	const child = spawn(command, args, options);
	child.once('error', (error) => spawnFailures.set(child, error));
	return child;
}

export type ForwardEvent =
	| { type: 'listening'; spec: ForwardSpec }
	| { type: 'listen-failed'; spec: ForwardSpec; code: string; message: string }
	| { type: 'connection-failed'; spec: ForwardSpec; message: string };

/**
 * Bridges open at once, across all ports. Each costs about four file
 * handles on the host (macOS allows 256 by default); connections beyond
 * the cap wait their turn instead of failing.
 */
export const MAX_BRIDGES = 48;

/**
 * How many bridges fit under this process's file-handle limit (`ulimit
 * -n`): each takes about four, plus one per waiting connection, plus what
 * Bring itself holds. Never above MAX_BRIDGES, never below 2.
 */
export function bridgesForFileLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return MAX_BRIDGES;
	}
	return Math.max(2, Math.min(MAX_BRIDGES, Math.floor((limit - 40) / 6)));
}

export interface ForwardOptions {
	specs: readonly ForwardSpec[];
	/** Start one bridge for one accepted connection — use `spawnBridge`. */
	openBridge: (spec: ForwardSpec) => Promise<ChildProcessWithoutNullStreams>;
	onEvent: (event: ForwardEvent) => void;
	/** After the client leaves, how long the bridge may take to exit. */
	bridgeGraceMs?: number;
	maxBridges?: number;
}

export interface Forwarding {
	/** Ports that are listening (failed ones are reported via onEvent). */
	listening: ForwardSpec[];
	close: () => Promise<void>;
}

/**
 * Bind every spec on 127.0.0.1 — never 0.0.0.0, so nothing on the LAN can
 * reach the container — and bridge each connection. A port that cannot be
 * bound is reported and skipped; the others keep working. No single
 * connection's failure stops the forwarder.
 */
export async function startForwarding(
	options: ForwardOptions,
): Promise<Forwarding> {
	const servers: Server[] = [];
	const listening: ForwardSpec[] = [];
	const bridges = new Set<ChildProcessWithoutNullStreams>();
	const sockets = new Set<Socket>();
	const grace = options.bridgeGraceMs ?? (BRIDGE_LINGER_SECONDS + 2) * 1000;
	// Lowered at run time if spawning hits the file-handle limit anyway.
	let cap = options.maxBridges ?? MAX_BRIDGES;
	let active = 0;
	const waiting: (() => void)[] = [];
	const release = () => {
		active--;
		while (active < cap && waiting.length > 0) {
			(waiting.shift() as () => void)();
		}
	};

	const bridge = (spec: ForwardSpec, socket: Socket) => {
		if (socket.destroyed) {
			return; // the client gave up while waiting for a free bridge
		}
		active++;
		let released = false;
		const done = () => {
			if (!released) {
				released = true;
				release();
			}
		};
		const failed = (message: string) => {
			socket.destroy();
			options.onEvent({ type: 'connection-failed', spec, message });
			done();
		};
		options.openBridge(spec).then(
			(child) => {
				const early =
					spawnFailures.get(child) ??
					(child.pid === undefined
						? new Error('the bridge process could not be started')
						: undefined);
				if (early !== undefined) {
					const code = (early as NodeJS.ErrnoException).code;
					const outOfHandles =
						code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN';
					if (outOfHandles && active > 1 && !socket.destroyed) {
						// The machine cannot hold this many bridges: remember
						// the ceiling and let this connection wait for a free
						// one instead of dropping it.
						cap = Math.max(1, active - 1);
						waiting.unshift(() => bridge(spec, socket));
						done();
						return;
					}
					failed(early.message);
					return;
				}
				bridges.add(child);
				let stderr = '';
				let sentBytes = 0;
				child.stderr.on('data', (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.stdout.on('data', (chunk: Buffer) => {
					sentBytes += chunk.length;
				});
				child.stdin.on('error', () => {});
				child.stdout.pipe(socket);
				socket.pipe(child.stdin);
				socket.resume();
				let killTimer: NodeJS.Timeout | undefined;
				socket.on('close', () => {
					// End-of-input lets the in-container helper end itself
					// (and its connection); the kill is only a backstop.
					child.stdin.end();
					killTimer = setTimeout(() => child.kill('SIGTERM'), grace);
				});
				child.on('close', (code) => {
					clearTimeout(killTimer);
					bridges.delete(child);
					socket.end();
					if (code !== 0 && sentBytes === 0 && stderr.trim() !== '') {
						options.onEvent({
							type: 'connection-failed',
							spec,
							message: stderr.trim(),
						});
					}
					done();
				});
				child.on('error', (error) => {
					bridges.delete(child);
					failed(error.message);
				});
			},
			(error: unknown) => {
				failed(error instanceof Error ? error.message : String(error));
			},
		);
	};

	const handle = (spec: ForwardSpec, socket: Socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.pause();
		if (active >= cap) {
			waiting.push(() => bridge(spec, socket));
		} else {
			bridge(spec, socket);
		}
	};

	for (const spec of options.specs) {
		// allowHalfOpen: a client may finish sending and still wait for the
		// reply; the socket is ended when the bridge closes.
		const server = createServer({ allowHalfOpen: true }, (socket) =>
			handle(spec, socket),
		);
		// A failure to accept (no file handles left) must not be fatal.
		server.on('error', () => {});
		const bound = await new Promise<boolean>((resolve) => {
			server.once('error', (error: NodeJS.ErrnoException) => {
				options.onEvent({
					type: 'listen-failed',
					spec,
					code: error.code ?? 'UNKNOWN',
					message: error.message,
				});
				resolve(false);
			});
			server.listen(spec.hostPort, '127.0.0.1', () => resolve(true));
		});
		if (bound) {
			servers.push(server);
			listening.push(spec);
			options.onEvent({ type: 'listening', spec });
		}
	}

	return {
		listening,
		close: async () => {
			waiting.length = 0;
			for (const socket of sockets) {
				socket.destroy();
			}
			for (const child of bridges) {
				child.stdin.end();
			}
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolve) => server.close(() => resolve())),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, Math.min(grace, 500)));
			for (const child of bridges) {
				child.kill('SIGTERM');
			}
		},
	};
}

/**
 * Turn a helper's stderr into one human line. "Connection refused" is the
 * common case — the server simply is not up yet.
 */
export function explainConnectionFailure(
	message: string,
	spec: ForwardSpec,
	workspaceName: string,
): string {
	const target =
		spec.targetHost === '127.0.0.1'
			? `port ${spec.targetPort}`
			: `${spec.targetHost}:${spec.targetPort}`;
	if (/EMFILE|ENFILE/.test(message)) {
		return 'this machine ran out of file handles for new connections (see `ulimit -n`)';
	}
	if (/refused/i.test(message)) {
		return `nothing is listening on ${target} inside ${workspaceName} yet`;
	}
	if (/no such container/i.test(message)) {
		// After a rebuild the cached container id is stale; the next
		// connection looks the workspace up again.
		return `${workspaceName}'s container was replaced or removed — the next connection uses the current one`;
	}
	if (/is not running/i.test(message)) {
		return `${workspaceName} is not running`;
	}
	if (/name|resolve|unknown host|not known/i.test(message)) {
		return `${spec.targetHost} cannot be resolved inside ${workspaceName}`;
	}
	return `${target}: ${message.split('\n')[0]}`;
}

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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

/** Bridge programs, in preference order (spike §mechanisms). */
export const HELPERS = ['socat', 'bash', 'node'] as const;
export type Helper = (typeof HELPERS)[number];

/** Prints the first available helper's name; exits 1 when there is none. */
export const PROBE_SCRIPT = `for h in ${HELPERS.join(' ')}; do command -v "$h" >/dev/null 2>&1 && { echo "$h"; exit 0; }; done; exit 1`;

/**
 * The argv run inside the container for one connection: stdin → port,
 * port → stdout. Every variant ends the WHOLE bridge as soon as either
 * side closes — a docker exec killed from the host would otherwise leave
 * the in-container half running (verified for exec, P4 §1 V3). `kill 0`
 * works because an exec'd process leads its own process group (V4).
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
				'exec 3<>"/dev/tcp/$0/$1" || exit 1; { cat <&3; kill 0; } & cat >&3; kill 0',
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
					'process.stdin.on("end",()=>process.exit(0));',
					'process.stdout.on("finish",()=>process.exit(0));',
				].join(''),
				targetHost,
				String(targetPort),
			];
	}
}

export type ForwardEvent =
	| { type: 'listening'; spec: ForwardSpec }
	| { type: 'listen-failed'; spec: ForwardSpec; code: string; message: string }
	| { type: 'connection-failed'; spec: ForwardSpec; message: string };

export interface ForwardOptions {
	specs: readonly ForwardSpec[];
	/** Start one bridge for one accepted connection. */
	openBridge: (spec: ForwardSpec) => Promise<ChildProcessWithoutNullStreams>;
	onEvent: (event: ForwardEvent) => void;
	/** After the client leaves, how long the bridge may take to exit. */
	bridgeGraceMs?: number;
}

export interface Forwarding {
	/** Ports that are listening (failed ones are reported via onEvent). */
	listening: ForwardSpec[];
	close: () => Promise<void>;
}

/**
 * Bind every spec on 127.0.0.1 — never 0.0.0.0, so nothing on the LAN can
 * reach the container — and bridge each connection. A port that cannot be
 * bound is reported and skipped; the others keep working.
 */
export async function startForwarding(
	options: ForwardOptions,
): Promise<Forwarding> {
	const servers: Server[] = [];
	const listening: ForwardSpec[] = [];
	const bridges = new Set<ChildProcessWithoutNullStreams>();
	const sockets = new Set<Socket>();
	const grace = options.bridgeGraceMs ?? 2000;

	const handle = (spec: ForwardSpec, socket: Socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.pause();
		options.openBridge(spec).then(
			(child) => {
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
					// EOF lets the in-container helper end itself (and its
					// connection); the kill is only a backstop.
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
				});
				child.on('error', (error) => {
					bridges.delete(child);
					socket.destroy();
					options.onEvent({
						type: 'connection-failed',
						spec,
						message: error.message,
					});
				});
			},
			(error: unknown) => {
				socket.destroy();
				options.onEvent({
					type: 'connection-failed',
					spec,
					message: error instanceof Error ? error.message : String(error),
				});
			},
		);
	};

	for (const spec of options.specs) {
		const server = createServer((socket) => handle(spec, socket));
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

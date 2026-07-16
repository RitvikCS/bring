import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../../src/application/context.js';
import type { OperationEvent } from '../../src/core/operation-events.js';
import type { WorkspaceRef } from '../../src/core/types.js';
import { workspaceIdentity } from '../../src/core/workspace-resolver.js';
import { makeBinDir, writeFakeBin } from './fake-bin.js';

// Harness for application-operation tests: a real temp workspace, fake
// devcontainer/docker executables, and a context that records events.

export interface OperationHarness {
	ctx: OperationContext;
	workspace: WorkspaceRef;
	events: OperationEvent[];
	binDir: string;
	stateDir: string;
	argvFile: string;
}

export function makeHarness(options: {
	/** docker ps JSON lines returned for this workspace ('' = none). */
	psOutput?: string;
	/** Shell body for the fake devcontainer executable. */
	devcontainerScript?: string;
	/** Shell body overriding the whole fake docker executable. */
	dockerScript?: string;
}): OperationHarness {
	const root = mkdtempSync(join(tmpdir(), 'bring-op-ws-'));
	mkdirSync(join(root, '.devcontainer'));
	writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
	const workspace: WorkspaceRef = {
		input: '.',
		rootPath: root,
		configPath: join(root, '.devcontainer', 'devcontainer.json'),
		identity: workspaceIdentity(root),
	};

	const binDir = makeBinDir();
	const stateDir = mkdtempSync(join(tmpdir(), 'bring-op-state-'));
	const argvFile = join(binDir, 'argv-log');
	const psOutput = options.psOutput ?? '';
	const inspectOutput = JSON.stringify(
		psOutput
			.split('\n')
			.filter((line) => line.trim().startsWith('{'))
			.map((line) => JSON.parse(line) as Record<string, string>)
			.map((row) => ({
				Id: row.ID ?? '',
				Name: `/${row.Names ?? ''}`,
				Created: '2026-07-16T12:00:00Z',
				Image: `sha256:${row.Image ?? ''}`,
				Config: {
					Image: row.Image ?? '',
					Labels: { 'devcontainer.local_folder': root },
				},
			})),
	);

	const dockerScript =
		options.dockerScript ??
		`printf '%s\\n' "docker $*" >> "${argvFile}"
case "$1 $2" in
	"ps --all") printf '%s\\n' '${psOutput}' ;;
	"container inspect") printf '%s\\n' '${inspectOutput}' ;;
	*) : ;;
esac`;
	writeFakeBin(binDir, 'docker', dockerScript);

	const devcontainerScript =
		options.devcontainerScript ??
		`printf '%s\\n' "devcontainer $*" >> "${argvFile}"
echo '{"outcome":"success","containerId":"new123"}'`;
	writeFakeBin(binDir, 'devcontainer', devcontainerScript);

	const events: OperationEvent[] = [];
	const ctx: OperationContext = {
		devcontainerExe: join(binDir, 'devcontainer'),
		dockerExe: join(binDir, 'docker'),
		stateDir,
		stateFile: join(stateDir, 'state.json'),
		env: { PATH: binDir },
		emit: (event) => events.push(event),
	};

	return { ctx, workspace, events, binDir, stateDir, argvFile };
}

export const RUNNING_PS =
	'{"ID":"run1","Names":"vsc-x","State":"running","Image":"vsc-img","Ports":"0.0.0.0:3000->3000/tcp"}';
export const STOPPED_PS =
	'{"ID":"stop1","Names":"vsc-x","State":"exited","Image":"vsc-img","Ports":""}';

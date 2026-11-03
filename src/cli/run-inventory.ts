import { createInterface } from 'node:readline/promises';
import {
	findDevcontainerExecutable,
	findExecutable,
} from '../adapters/find-executable.js';
import type { OperationContext } from '../application/context.js';
import { removeImageResources } from '../application/image-actions.js';
import { listResources } from '../application/list-resources.js';
import { exitCodeForProblem } from '../core/errors.js';
import {
	type DevContainerImageResource,
	type DevContainerResource,
	isImagePruneCandidate,
} from '../core/resources.js';
import { bringStateDir } from '../stores/paths.js';
import { loadState, stateFilePath } from '../stores/workspace-store.js';
import { formatBytes } from '../tui/ImagesPane.js';
import { EXIT } from './exit-codes.js';

// Direct, scriptable forms of the TUI's Containers and Images sections
// (P4 §3). The field names below are a public contract once released:
// add fields freely, never rename or remove them.

export function containerDocument(container: DevContainerResource) {
	return {
		id: container.id,
		name: container.name,
		state: container.state,
		statusText: container.statusText,
		createdAt: container.createdAt,
		imageId: container.imageId,
		imageName: container.imageName,
		ports: container.ports,
		workspacePath: container.workspacePath,
		workspaceName: container.workspaceName,
		role: container.role,
		...(container.serviceName === undefined
			? {}
			: { serviceName: container.serviceName }),
	};
}

export function imageDocument(image: DevContainerImageResource) {
	return {
		id: image.id,
		displayName: image.displayName,
		references: image.references,
		createdAt: image.createdAt,
		sizeBytes: image.sizeBytes,
		dangling: image.dangling,
		usage: image.usage,
		pruneCandidate: isImagePruneCandidate(image),
		containerNames: image.containerNames,
		descendantContainerNames: image.descendantContainerNames,
		workspacePaths: image.workspacePaths,
		workspaceNames: image.workspaceNames,
	};
}

/**
 * Exactly what the TUI's `p` stages: unused AND dangling. Cached bases and
 * named unused images are never picked automatically. Shared layers mean
 * the byte total is an upper bound, not a promise.
 */
export function planPrune(images: readonly DevContainerImageResource[]): {
	candidates: DevContainerImageResource[];
	upToBytes: number;
} {
	const candidates = images.filter(isImagePruneCandidate);
	return {
		candidates,
		upToBytes: candidates.reduce((total, image) => total + image.sizeBytes, 0),
	};
}

function dockerOrExplain(): string | null {
	const docker = findExecutable('docker', process.env.PATH);
	if (docker === null) {
		console.error('Bring needs Docker, which was not found on PATH.');
		console.error('Run `bring doctor` for the full picture.');
	}
	return docker;
}

function knownWorkspacePaths(): string[] {
	return loadState(stateFilePath(process.env)).workspaces.map((w) => w.path);
}

/** `bring containers --json` / `bring images --json`. */
export async function runInventory(
	section: 'containers' | 'images',
): Promise<number> {
	const dockerExe = dockerOrExplain();
	if (dockerExe === null) {
		return EXIT.dependency;
	}
	const listed = await listResources({
		dockerExe,
		env: process.env,
		includeImages: section === 'images',
		knownWorkspacePaths: knownWorkspacePaths(),
	});
	if (!listed.ok) {
		return reportDockerFailure(listed.problem.summary, true);
	}
	const { inventory } = listed;
	const body =
		section === 'containers'
			? { containers: inventory.containers.map(containerDocument) }
			: { images: (inventory.images ?? []).map(imageDocument) };
	console.log(
		JSON.stringify(
			{ schemaVersion: 1, refreshedAt: inventory.refreshedAt, ...body },
			null,
			2,
		),
	);
	return EXIT.success;
}

/**
 * `bring images prune [--dry-run] [--yes] [--json]` (P4 §3, DD-8). The
 * removal itself is the TUI's: per-workspace locks, no --force,
 * --no-prune, and a refusal if anything became attached meanwhile.
 */
export async function runPrune(route: {
	json: boolean;
	yes: boolean;
	dryRun: boolean;
}): Promise<number> {
	const dockerExe = dockerOrExplain();
	if (dockerExe === null) {
		return EXIT.dependency;
	}
	const listed = await listResources({
		dockerExe,
		env: process.env,
		includeImages: true,
		knownWorkspacePaths: knownWorkspacePaths(),
	});
	if (!listed.ok) {
		return reportDockerFailure(listed.problem.summary, route.json);
	}
	const { candidates, upToBytes } = planPrune(listed.inventory.images ?? []);
	const doc = (extra: Record<string, unknown>) =>
		JSON.stringify(
			{
				schemaVersion: 1,
				operation: 'prune',
				dryRun: route.dryRun,
				candidates: candidates.map((image) => ({
					id: image.id,
					displayName: image.displayName,
					sizeBytes: image.sizeBytes,
				})),
				upToBytes,
				...extra,
			},
			null,
			2,
		);

	if (candidates.length === 0) {
		const message =
			'Nothing to prune — no unused, unnamed Dev Container images.';
		console.log(route.json ? doc({ outcome: 'success', message }) : message);
		return EXIT.success;
	}

	const summary = `${candidates.length} unused, unnamed image${
		candidates.length === 1 ? '' : 's'
	} (up to ${formatBytes(upToBytes)})`;
	if (route.dryRun) {
		if (route.json) {
			console.log(
				doc({ outcome: 'success', message: `Would remove ${summary}` }),
			);
		} else {
			printCandidates(`Would remove ${summary}:`, candidates);
			console.log(
				`Nothing was changed. Run \`bring images prune --yes\` to remove ${
					candidates.length === 1 ? 'it' : 'them'
				}.`,
			);
		}
		return EXIT.success;
	}

	if (!route.yes) {
		const interactive =
			!route.json &&
			process.stdin.isTTY === true &&
			process.stdout.isTTY === true;
		if (!interactive) {
			console.error(
				'prune deletes images — confirm with --yes, or preview with --dry-run.',
			);
			return EXIT.usage;
		}
		printCandidates(`About to remove ${summary}:`, candidates);
		console.log('Shared layers mean actual recovery may be lower.');
		if (
			!(await confirm(
				`Remove ${candidates.length === 1 ? 'it' : 'them'}? [y/N] `,
			))
		) {
			console.log('Nothing was changed.');
			return EXIT.success;
		}
	}

	const env = process.env;
	const ctx: OperationContext = {
		// Image removal only talks to Docker; the devcontainer CLI is unused.
		devcontainerExe: findDevcontainerExecutable(env)?.path ?? '',
		dockerExe,
		stateDir: bringStateDir(env),
		stateFile: stateFilePath(env),
		env,
		emit: () => {},
	};
	const removed = await removeImageResources(ctx, candidates);
	if (!removed.ok) {
		if (route.json) {
			console.log(
				doc({
					outcome: 'failed',
					message: removed.message,
					error: {
						code: removed.problem.code,
						summary: removed.problem.summary,
					},
				}),
			);
		} else {
			console.error(`✗ ${removed.message}`);
		}
		return exitCodeForProblem(removed.problem.code);
	}
	const message = `Removed ${summary}`;
	console.log(
		route.json
			? doc({
					outcome: 'success',
					message,
					removedIds: candidates.map((i) => i.id),
				})
			: `✓ ${message}`,
	);
	return EXIT.success;
}

function printCandidates(
	heading: string,
	candidates: readonly DevContainerImageResource[],
): void {
	console.log(heading);
	for (const image of candidates) {
		console.log(`  • ${image.displayName}  ${formatBytes(image.sizeBytes)}`);
	}
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

function reportDockerFailure(summary: string, json: boolean): number {
	if (json) {
		console.log(
			JSON.stringify(
				{
					schemaVersion: 1,
					outcome: 'failed',
					error: { code: 'DOCKER_FAILED', summary, remedy: 'bring doctor' },
				},
				null,
				2,
			),
		);
	} else {
		console.error(summary);
		console.error('Run `bring doctor` for the full picture.');
	}
	return exitCodeForProblem('DOCKER_FAILED');
}

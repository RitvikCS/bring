import { basename } from 'node:path';
import { removeImages } from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import {
	type DevContainerImageResource,
	isImageAttached,
} from '../core/resources.js';
import { workspaceIdentity } from '../core/workspace-resolver.js';
import { acquireOperationLock } from '../stores/op-lock.js';
import type { OperationContext } from './context.js';

export type ImageRemovalResult =
	| { ok: true; message: string }
	| { ok: false; message: string; problem: BringProblem };

/** Remove an exact, pre-confirmed set. Docker gets no force and no parent prune. */
export async function removeImageResources(
	ctx: OperationContext,
	images: readonly DevContainerImageResource[],
): Promise<ImageRemovalResult> {
	if (images.length === 0) {
		return failed('No images are selected.');
	}
	const attached = images.filter(isImageAttached);
	if (attached.length > 0) {
		return failed(
			`${attached.map((image) => image.displayName).join(', ')} cannot be removed while referenced by ${attached.flatMap((image) => image.containerNames).join(', ')}.`,
		);
	}
	// The impacted workspaces' operation locks make image removal refuse to
	// race a concurrent up/rebuild the same way container mutations do — the
	// attached/unused verdict above comes from an inventory snapshot that a
	// parallel `bring up` may already be invalidating.
	const releases: (() => void)[] = [];
	const workspacePaths = [
		...new Set(images.flatMap((image) => image.workspacePaths)),
	];
	try {
		for (const path of workspacePaths) {
			const lock = acquireOperationLock(ctx.stateDir, workspaceIdentity(path));
			if (!lock.ok) {
				return failed(
					`Another Bring operation (pid ${lock.holderPid}) is already working on ${basename(path)}.`,
					'OPERATION_CONFLICT',
				);
			}
			releases.push(lock.release);
		}
		// Tagged images are removed via every reference: Docker refuses a
		// forceless removal by id when multiple repositories reference the
		// image, but untagging each reference removes it without --force.
		const removed = await removeImages(
			ctx.dockerExe,
			images.flatMap((image) =>
				image.references.length > 0 ? image.references : [image.id],
			),
			{ env: ctx.env },
		);
		if (!removed.ok) {
			return failed(
				`Docker could not remove the selected images: ${removed.message}`,
			);
		}
		return {
			ok: true,
			message: `${images.length} image${images.length === 1 ? '' : 's'} removed`,
		};
	} finally {
		for (const release of releases) {
			release();
		}
	}
}

function failed(
	message: string,
	code: BringProblem['code'] = 'DOCKER_FAILED',
): ImageRemovalResult {
	return {
		ok: false,
		message,
		problem: { code, summary: message },
	};
}

import { removeImages } from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import {
	type DevContainerImageResource,
	isImageAttached,
} from '../core/resources.js';
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
	const removed = await removeImages(
		ctx.dockerExe,
		images.map((image) => image.id),
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
}

function failed(message: string): ImageRemovalResult {
	return {
		ok: false,
		message,
		problem: { code: 'DOCKER_FAILED', summary: message },
	};
}

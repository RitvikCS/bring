import type { ForgetResult } from '../application/forget-workspace.js';
import { EXIT } from './exit-codes.js';

// `bring forget` output, plain and --json (P4 §3). Exit codes are identical
// in both modes: not found → 3, ambiguous → 2.

export function reportForget(result: ForgetResult): number {
	switch (result.outcome) {
		case 'forgotten':
			console.log(
				`Forgot ${result.name} (${result.entry.path}). Containers, images, and files are untouched.`,
			);
			return EXIT.success;
		case 'empty-registry':
			console.log('No workspaces remembered — nothing to forget.');
			return EXIT.success;
		case 'not-found':
			console.error(
				`No remembered workspace matches \`${result.target}\` — see \`bring ls\`.`,
			);
			return EXIT.resolution;
		case 'ambiguous':
			console.error(
				`\`${result.target}\` matches several remembered workspaces:\n`,
			);
			for (const path of result.candidates) {
				console.error(`  ${path}`);
			}
			console.error('\nForget one by its full path.');
			return EXIT.usage;
	}
}

/** `bring forget --json` (P4 §3): same outcomes and exit codes, one document. */
export function forgetDocument(result: ForgetResult): {
	doc: Record<string, unknown>;
	exitCode: number;
} {
	const base = { schemaVersion: 1, operation: 'forget' };
	switch (result.outcome) {
		case 'forgotten':
			return {
				doc: {
					...base,
					outcome: 'success',
					workspace: result.entry.path,
					workspaceName: result.name,
					message: `Forgot ${result.name}. Containers, images, and files are untouched.`,
				},
				exitCode: EXIT.success,
			};
		case 'empty-registry':
			return {
				doc: {
					...base,
					outcome: 'success',
					message: 'No workspaces remembered — nothing to forget.',
				},
				exitCode: EXIT.success,
			};
		case 'not-found':
			return {
				doc: {
					...base,
					outcome: 'failed',
					error: {
						code: 'WORKSPACE_NOT_FOUND',
						summary: `No remembered workspace matches \`${result.target}\`.`,
						remedy: 'bring ls',
					},
				},
				exitCode: EXIT.resolution,
			};
		case 'ambiguous':
			return {
				doc: {
					...base,
					outcome: 'failed',
					candidates: result.candidates,
					error: {
						code: 'USAGE_ERROR',
						summary: `\`${result.target}\` matches several remembered workspaces; forget one by its full path.`,
					},
				},
				exitCode: EXIT.usage,
			};
	}
}

export function reportForgetJson(result: ForgetResult): number {
	const { doc, exitCode } = forgetDocument(result);
	console.log(JSON.stringify(doc, null, 2));
	return exitCode;
}

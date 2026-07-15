import type { BringProblem } from './errors.js';

// Structured events emitted by application operations (spec §8.3). Both the
// direct-command renderer and the future TUI consume these; neither ever
// spawns a process itself.

export type OperationStage =
	| 'validating'
	| 'reading-config'
	| 'building'
	| 'creating'
	| 'starting'
	| 'running-hooks'
	| 'stopping'
	| 'removing'
	| 'ready';

export type OperationKind =
	| 'up'
	| 'down'
	| 'rebuild'
	| 'remove'
	| 'shell'
	| 'status'
	| 'logs';

export interface OperationResult {
	operation: OperationKind;
	outcome: 'success' | 'failed' | 'cancelled' | 'interrupted';
	workspace: string;
	workspaceName: string;
	message: string;
	durationMs: number;
	containerIds: string[];
	problem?: BringProblem;
	logPath?: string;
}

export type OperationEvent =
	| { type: 'started'; operation: OperationKind; workspaceName: string }
	| { type: 'stage'; stage: OperationStage; message: string }
	| { type: 'output'; stream: 'stdout' | 'stderr'; chunk: string }
	| { type: 'completed'; result: OperationResult };

export type EmitEvent = (event: OperationEvent) => void;

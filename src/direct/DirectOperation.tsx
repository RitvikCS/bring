import { Text } from 'ink';
import { useEffect, useState } from 'react';
import type { OperationEvent } from '../core/operation-events.js';
import { Spinner } from './Spinner.js';

export interface DirectOperationProps {
	/** Subscribe to operation events; returns an unsubscribe function. */
	subscribe: (listener: (event: OperationEvent) => void) => () => void;
	initialMessage: string;
}

/**
 * The compact animated line for a running direct command (spec §10.1):
 * one spinner, the latest stage message, nothing else. The parent unmounts
 * it when the operation settles and prints the final summary as plain text
 * so it survives in the scrollback.
 */
export function DirectOperation({
	subscribe,
	initialMessage,
}: DirectOperationProps) {
	const [message, setMessage] = useState(initialMessage);
	useEffect(
		() =>
			subscribe((event) => {
				if (event.type === 'stage') {
					setMessage(event.message);
				}
			}),
		[subscribe],
	);
	return (
		<Text>
			<Spinner /> {message}
		</Text>
	);
}

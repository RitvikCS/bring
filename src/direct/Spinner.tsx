import { Text } from 'ink';
import { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/** The one-line braille spinner for direct commands (P1-27, spec §10.2). */
export function Spinner() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setFrame((current) => (current + 1) % FRAMES.length),
			INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, []);
	return <Text color="cyan">{FRAMES[frame]}</Text>;
}

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function getVersion(): string {
	// Resolved relative to the compiled file (dist/cli/version.js), so this
	// finds the package's own package.json wherever it is installed.
	const pkg = require('../../package.json') as { version: string };
	return pkg.version;
}

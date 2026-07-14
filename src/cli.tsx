#!/usr/bin/env node
import { render } from 'ink';
import { runDoctor } from './application/doctor.js';
import { EXIT } from './cli/exit-codes.js';
import { helpText } from './cli/help.js';
import { parseArgv } from './cli/parse-argv.js';
import { renderDoctorHuman, renderDoctorJson } from './cli/render-doctor.js';
import { getVersion } from './cli/version.js';
import { App } from './tui/App.js';

async function main(): Promise<number> {
	const route = parseArgv(process.argv.slice(2));

	switch (route.kind) {
		case 'version': {
			console.log(getVersion());
			return EXIT.success;
		}
		case 'help': {
			console.log(helpText(getVersion()));
			return EXIT.success;
		}
		case 'tui': {
			const instance = render(<App version={getVersion()} />);
			instance.unmount();
			await instance.waitUntilExit();
			return EXIT.success;
		}
		case 'doctor': {
			const report = await runDoctor();
			const color =
				process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
			console.log(
				route.json
					? renderDoctorJson(report)
					: renderDoctorHuman(report, { color }),
			);
			return report.healthy ? EXIT.success : EXIT.dependency;
		}
		case 'usage-error': {
			console.error(route.message);
			console.error('Run `bring --help` for usage.');
			return EXIT.usage;
		}
		case 'unknown-option': {
			console.error(`Unknown option: ${route.option}`);
			console.error('Run `bring --help` for usage.');
			return EXIT.usage;
		}
		case 'not-implemented': {
			console.error(`\`bring ${route.input}\` is not implemented yet.`);
			console.error(
				'This is an early development release — run `bring --help`.',
			);
			return EXIT.usage;
		}
	}
}

process.exitCode = await main();

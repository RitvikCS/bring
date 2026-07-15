#!/usr/bin/env node
import { render } from 'ink';
import { findExecutable } from './adapters/find-executable.js';
import { runDoctor } from './application/doctor.js';
import { listKnownWorkspaces } from './application/list-workspaces.js';
import { EXIT } from './cli/exit-codes.js';
import { helpText } from './cli/help.js';
import { parseArgv } from './cli/parse-argv.js';
import { renderDoctorHuman, renderDoctorJson } from './cli/render-doctor.js';
import { runDirect } from './cli/run-direct.js';
import { getVersion } from './cli/version.js';
import { stateFilePath } from './stores/workspace-store.js';
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
		case 'direct': {
			return await runDirect(route);
		}
		case 'ls': {
			const listings = await listKnownWorkspaces({
				stateFile: stateFilePath(process.env),
				dockerExe: findExecutable('docker', process.env['PATH']),
				env: process.env,
			});
			if (route.json) {
				console.log(
					JSON.stringify({ schemaVersion: 1, workspaces: listings }, null, 2),
				);
				return EXIT.success;
			}
			if (listings.length === 0) {
				console.log(
					'No workspaces yet — Bring remembers a project after its first `bring up`.',
				);
				return EXIT.success;
			}
			const nameWidth = Math.max(...listings.map((l) => l.name.length), 4);
			for (const l of listings) {
				console.log(
					`${l.name.padEnd(nameWidth)}  ${l.status.padEnd(11)}  ${l.path}`,
				);
			}
			return EXIT.success;
		}
		case 'section': {
			console.error(
				`\`bring ${route.section}\` opens the full-screen interface, which is still being built.`,
			);
			console.error('Direct commands work today — see `bring --help`.');
			return EXIT.usage;
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

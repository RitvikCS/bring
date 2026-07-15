#!/usr/bin/env node
import { render } from 'ink';
import { findExecutable } from './adapters/find-executable.js';
import { runDoctor } from './application/doctor.js';
import { listKnownWorkspaces } from './application/list-workspaces.js';
import { type AnsiCode, makePaint } from './cli/ansi.js';
import { EXIT } from './cli/exit-codes.js';
import { helpText } from './cli/help.js';
import { parseArgv } from './cli/parse-argv.js';
import { renderDoctorHuman, renderDoctorJson } from './cli/render-doctor.js';
import { runDirect } from './cli/run-direct.js';
import { getVersion } from './cli/version.js';
import { stateFilePath } from './stores/workspace-store.js';
import { App } from './tui/App.js';
import { realEnvironment } from './tui/load.js';
import {
	type Section,
	statusColor,
	statusLabel,
	statusSymbol,
} from './tui/state.js';

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
			return runTui('workspaces');
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
				dockerExe: findExecutable('docker', process.env.PATH),
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
			const color =
				process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
			const paint = makePaint(color);
			const nameWidth = Math.max(...listings.map((l) => l.name.length), 4);
			for (const l of listings) {
				const inkColor = statusColor(l.status);
				const status = `${statusSymbol(l.status)} ${statusLabel(l.status).padEnd(12)}`;
				console.log(
					`${paint('bold', l.name.padEnd(nameWidth))}  ${
						inkColor === undefined
							? status
							: paint(inkColor as AnsiCode, status)
					}  ${paint('dim', l.path)}`,
				);
			}
			return EXIT.success;
		}
		case 'section': {
			return runTui(route.section as Section);
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

/** Open the full-screen interface (spec §11.1) at the given section. */
async function runTui(section: Section): Promise<number> {
	if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
		console.error('The full-screen interface needs an interactive terminal.');
		console.error('Direct commands work everywhere — see `bring --help`.');
		return EXIT.usage;
	}
	const instance = render(
		<App
			environment={realEnvironment(process.env)}
			version={getVersion()}
			initialSection={section}
		/>,
		{ alternateScreen: true, incrementalRendering: true, maxFps: 30 },
	);
	// Incremental rendering can leave stale cells behind after a resize
	// (fragments of old borders floating in blank space) — drop the
	// remembered output so the next frame repaints from scratch.
	const clearOnResize = () => instance.clear();
	process.stdout.on('resize', clearOnResize);
	try {
		await instance.waitUntilExit();
	} finally {
		process.stdout.off('resize', clearOnResize);
	}
	return EXIT.success;
}

process.exitCode = await main();

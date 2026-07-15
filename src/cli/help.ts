// The down/remove translation table is a product requirement (spec §3):
// the destructive action must be unmistakable before anyone runs it. The
// upstream CLI has no stop/down commands, so the table speaks in docker
// terms — which is also literally how Bring implements both actions.
export function helpText(version: string): string {
	return `bring ${version} — Dev Containers without the ceremony

Usage
  bring [target] <action>      Run one operation directly
  bring <global-command>       doctor · ls
  bring                        Open the full-screen interface

Targets
  .  this  <path>              Default target is the current directory.
                               Bring finds the nearest devcontainer config
                               upward from the target.

Actions
  up                           Create/start the dev container for a workspace
  down                         Stop it, keeping containers for a fast restart
  rebuild                      Rebuild the environment (--no-cache supported)
  shell                        Open a shell inside it (-- <cmd> to override)
  logs                         Show the last captured operation log (--clear)
  status                       Show a one-workspace status summary
  remove                       Stop and DELETE devcontainer resources
                               (asks first; source files are never touched)

Note on down vs remove
  bring down    acts like  docker stop   (containers kept, restart is fast)
  bring remove  acts like  docker rm     (containers deleted)

Global commands
  doctor                       Check Node, the devcontainer CLI, and Docker;
                               explain what is missing
  ls                           List known workspaces with live status

Options
  --help, -h                   Show this help
  --version, -v                Show the Bring version
  --json                       Machine-readable output, never animated
  --verbose                    Stream the underlying command output
  --config <path>              Use an explicit devcontainer.json
  --yes, -y                    Skip the confirmation prompt (remove)
  --no-cache                   Rebuild without the Docker build cache

Examples
  bring up                     Start the current project
  bring ../api down            Stop the api project next door
  bring . shell -- zsh         Open zsh instead of bash
  bring status --json          Feed a script

Inside the TUI, press ? for keyboard help.
Follow along: https://github.com/RitvikCS/bring`;
}

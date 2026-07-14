// The down/remove translation table is a product requirement (spec §3):
// the destructive action must be unmistakable before anyone runs it. The
// upstream CLI has no stop/down commands, so the table speaks in docker
// terms — which is also literally how Bring implements both actions.
export function helpText(version: string): string {
	return `bring ${version} — Dev Containers without the ceremony

Usage
  bring                        Open the full-screen interface
  bring [target] <action>      Run one operation directly
  bring doctor                 Check that everything Bring needs is available

Targets
  .  this  <path>              Default target is the current directory.

Actions
  up                           Create/start the dev container for a workspace
  down                         Stop it, keeping containers for a fast restart
  rebuild                      Rebuild the environment (--no-cache supported)
  shell                        Open an interactive shell inside it
  logs                         Show the last captured operation log
  status                       Show a one-workspace status summary
  remove                       Stop and DELETE devcontainer resources
                               (source files are never touched)

Note on down vs remove
  bring down    acts like  docker stop   (containers kept, restart is fast)
  bring remove  acts like  docker rm     (containers deleted)

Global commands
  doctor                       Check Node, the devcontainer CLI, and Docker;
                               explain what is missing (--json for scripts)

Options
  --help, -h                   Show this help
  --version, -v                Show the Bring version

Workspace commands above land in the next release; this build routes
--help, --version, and doctor. Follow along: https://github.com/RitvikCS/bring`;
}

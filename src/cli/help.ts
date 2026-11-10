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

TUI sections
  bring workspaces             Workspace lifecycle and logs
  bring containers             Dev Container resources and safe actions
  bring images                 Dev Container image usage and cleanup
  bring profiles               Dotfiles profiles: create, edit, assign

Targets
  .  this  <path>              Default target is the current directory.
                               Bring finds the nearest devcontainer config
                               upward from the target.

Actions
  up                           Create/start the dev container for a workspace
  down                         Stop it, keeping containers for a fast restart
  rebuild                      Rebuild the environment (--no-cache supported)
  shell                        Open a shell inside it (-- <cmd> to override)
  exec -- <cmd>                Run one command inside it, non-interactively;
                               exits with the command's own exit code
                               (--json, --timeout <s>, --detach)
  forward [ports…]             Reach servers in the container from this
                               machine until Ctrl+C. No ports: uses
                               forwardPorts from devcontainer.json
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
  forget <workspace>           Drop a workspace from Bring's memory
                               (containers, images, and files stay)
  images prune                 Remove unused, unnamed Dev Container images
                               (--dry-run to preview, --yes to confirm)
  containers --json            List Dev Container containers as JSON
  images --json                List Dev Container images as JSON

Options
  --help, -h                   Show this help
  --version, -v                Show the Bring version
  --json                       Machine-readable output, never animated
  --verbose                    Stream the underlying command output
  --events                     up/rebuild/down/remove: print progress as
                               JSON lines, the last one is the result
  --config <path>              Use an explicit devcontainer.json
  --yes, -y                    Skip the confirmation prompt (remove, prune)
  --dry-run                    images prune: show what would be removed
  --no-cache                   Rebuild without the Docker build cache
  --timeout <seconds>          exec: stop the command after N seconds (exit 124)
  --detach                     exec: start in the background, print pid
                               and a stop command
  --dotfiles <repo|none>       Apply a dotfiles repo during up/rebuild.
                               Remembered after one success; none skips once
  --profile <name|none>        Use a named dotfiles profile for this run
                               (manage profiles in the TUI: bring profiles)

Examples
  bring up                     Start the current project
  bring ../api down            Stop the api project next door
  bring . shell -- zsh         Open zsh instead of bash
  bring exec -- npm test       Run the tests inside the container
  bring forward 5173           Open the container's port 5173 on localhost
  bring status --json          Feed a script

Inside the TUI, press ? for keyboard help.
Follow along: https://github.com/RitvikCS/bring`;
}

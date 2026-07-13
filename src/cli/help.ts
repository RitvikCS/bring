// The down/remove translation table is a product requirement (spec §3):
// users coming from the upstream CLI must see that Bring's `down` maps to
// upstream `stop`, and Bring's `remove` maps to upstream `down`.
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

Note for devcontainer CLI users
  bring down    runs  devcontainer stop   (preserve)
  bring remove  runs  devcontainer down   (delete)

Options
  --help, -h                   Show this help
  --version, -v                Show the Bring version

Most commands above land in the next release; this build routes
--help and --version only. Follow along: https://github.com/RitvikCS/bring`;
}

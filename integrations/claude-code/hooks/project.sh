# The project a hook's session works in: the name of the folder at the root of its repository, or
# of the working directory outside one. Every ask names its project this way, so one project never
# appears in the inbox under two names. Reads the hook's JSON input from $1.
project_of() {
	local cwd
	cwd=$(jq -r '.cwd // empty' <<<"$1")
	cwd=${cwd:-$PWD}
	basename "$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"
}

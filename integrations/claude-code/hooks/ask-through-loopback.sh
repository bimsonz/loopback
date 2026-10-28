#!/usr/bin/env bash
# Turns Claude Code's built-in question prompt away and points the agent at Loopback instead, so
# every question lands in the person's inbox, named by the project it comes from.
set -euo pipefail
source "$(dirname "$0")/project.sh"

input=$(cat)
project=$(project_of "$input")

reason="Ask through Loopback instead: the person answers questions from their Loopback inbox, not this terminal. Call mcp__plugin_loopback_loopback__ask_question once for each question, with the same question and choices (multiSelect becomes multiple: true), any background in context, and project: \"$project\". If the Loopback tools are not available in this session, ask in your reply instead."

jq -n --arg reason "$reason" '{
	hookSpecificOutput: {
		hookEventName: "PreToolUse",
		permissionDecision: "deny",
		permissionDecisionReason: $reason
	}
}'

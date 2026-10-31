#!/usr/bin/env bash
# Tells the agent, as its session starts, that every question for the person goes through Loopback.
set -euo pipefail
source "$(dirname "$0")/project.sh"

input=$(cat)
project=$(project_of "$input")

context="Loopback is connected. The person answers everything from their Loopback inbox, across all their projects, not from this terminal. Whenever you need something from them, whether a clarifying question, a choice between approaches, a preference, permission to go ahead, or sign-off on work, ask with mcp__plugin_loopback_loopback__ask_question or show the work with mcp__plugin_loopback_loopback__request_review, with project: \"$project\". When they ask you to explain or walk them through something that breaks into several points (findings, options, steps, a list of changes), send it with mcp__plugin_loopback_loopback__send_briefing so they can reply on each point, instead of writing the list in your reply. Do not ask in your reply and do not end a turn waiting for an answer in this conversation. If the Loopback tools are not available in this session, ask in your reply instead."

jq -n --arg context "$context" '{
	hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $context }
}'

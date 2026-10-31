#!/usr/bin/env bash
# When the agent ends its turn by asking the person something in the conversation, sends it back to
# ask through Loopback instead, where the person is answering.
set -euo pipefail
source "$(dirname "$0")/project.sh"

input=$(cat)

# Already continuing because of this hook: let it stop, so it can never loop.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
# A Loopback ask is already waiting in the background: the question has been asked.
jq -e '.background_tasks // [] | tostring | test("loopback")' <<<"$input" >/dev/null && exit 0

# The last paragraph of the agent's final message.
ending=$(jq -r '.last_assistant_message // ""' <<<"$input" | awk 'BEGIN { RS = "" } { last = $0 } END { print last }')

asks='\?[*_)"'"'"'[:space:]]*$|let me know|tell me (which|what|if|whether|how)|which (one|option|would you)|do you want|would you (like|prefer|rather)|should i |shall i |your call'
printf '%s' "$ending" | grep -Eiq "$asks" || exit 0

project=$(project_of "$input")
reason="You ended your turn asking the person something in this conversation, but they answer from their Loopback inbox, not this terminal. Put that question to them with mcp__plugin_loopback_loopback__ask_question, with any choices you offered as options and project: \"$project\" (or show the work with mcp__plugin_loopback_loopback__request_review if you are asking them to look at something, or send the points with mcp__plugin_loopback_loopback__send_briefing if you were explaining several). If the Loopback tools are not available in this session, you may stop."

jq -n --arg reason "$reason" '{ decision: "block", reason: $reason }'

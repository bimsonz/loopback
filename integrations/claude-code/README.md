# Loopback for Claude Code

A Claude Code plugin that routes every question the agent has for you to your Loopback inbox,
without your having to ask it to. Three hooks cover the ways an agent asks:

- **When a session starts**, the agent is told that you answer from Loopback, and to put every
  question, choice, request for permission or piece of work to sign off there, naming the project.
- **Claude Code's built-in question prompt** is turned away, and the agent asks through Loopback
  instead.
- **A turn that ends with a question in the conversation** is sent back once, to ask it through
  Loopback. A turn whose question is already waiting in Loopback is left alone.

Every ask names its project the same way: the folder at the root of the repository the session is
in.

## Install

The plugin connects Claude Code to Loopback as well, so there is nothing else to set up:

```sh
claude plugin install loopback --marketplace bimsonz/loopback
printf '{"url":"https://<your-worker>","token":"<your-token>"}' \
  | claude plugin configure loopback@loopback --values-stdin
```

The token is kept in the system's credential store. With several Claude Code accounts, run both
commands once for each, with `CLAUDE_CONFIG_DIR` set to that account's directory. The tools appear as
`mcp__plugin_loopback_loopback__*`, and the hooks take effect in sessions started afterwards; they
need `jq` and `git` on your PATH.

The plugin talks only to the Loopback deployment you configure.

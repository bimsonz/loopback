# Briefings

A third kind of ask, next to question and review. A briefing is how an agent explains something
that breaks into several points, so the person can go back on each point on its own and drill into
it until it is resolved.

## Why

The moment it comes from: the person asks an agent to help them understand something, and the
agent answers with lists, sometimes several. The person wants to go back on particular points:
ask about one, push back on another, leave a third alone. Then keep drilling into each one until
it is resolved.

Nothing in Loopback fits that today. A question takes one answer and closes. A review takes one
verdict and closes. In chat it turns into "list 2, point 3: …" typed into one long reply, and a
conversation that has to be kept going for ages to work through every point. The person wants a
consistent, structured way to reply, where each point keeps its own thread.

## What success looks like

- The person opens a briefing and sees, at a glance, what needs them. Everything else is folded
  away.
- Every point is one collapsed line until they open it.
- On any point they can write something (a question, a push-back, a comment) or say nothing. They
  never have to touch every point.
- The agent answers on the points they wrote on. Its answer stays with that point. When answering,
  the agent may break a point down into sub-points, each of which works the same way.
- A point the person marks resolved folds away with everything beneath it.
- The briefing closes when every point is resolved, or when the person finishes or dismisses it.
  The agent then has everything, keyed to each point, and is free to raise a new question.
- The agent never has to work out which point a reply is about.

## Non-goals

- Choices (buttons) on a point. A briefing explains; it does not ask for decisions. When the agent
  needs a decision, it asks a question.
- Picking up a briefing in a new agent session after the old one ended. As with every ask today,
  the briefing stays in the inbox and replies are kept, but only the session that opened it
  follows it.
- A sound or chime when an ask arrives. That's separate work.
- Spotting a list the agent wrote in chat and turning it into a briefing automatically.

## Constraints

- **Additive only.** Separate work is building the hosted product on `@loopbackhq/server`. This
  must not change the gate, `Spaces`, `Declinable`, hosting, or the shape of anything that exists,
  apart from new union members and new optional fields. Opening a
  briefing goes through the existing `open` operation, so a host that meters or declines opens
  covers briefings without changes. A host whose frontend switches on `ask.kind` or
  `reply.outcome` gets a compile error when it upgrades, pointing at what to add. That's
  expected.
- **No storage migration.** `asks.kind` is free text and prompts and entries are stored as JSON, so
  a briefing fits the existing tables.
- **Contract first.** Every new shape goes in `packages/protocol/spec/main.tsp`, then `pnpm generate`.
- **The thread stays an append-only log.** Point state (resolved, needs you, sub-points) is folded
  from the prompt and the thread, never stored separately.

## The shape

### Points and their ids

A briefing has a title, an optional summary, and one or more sections. Each section has an
optional title and its points. Sections are headings only: top-level points are numbered `1`,
`2`, `3` … straight through the whole briefing, so "point 7" is never ambiguous. Sub-points
the agent adds later are numbered beneath their parent: `3.1`, `3.2`, and `3.2.1` one level
further down. Adding sub-points to the same parent again continues the numbering. Points go at
most three levels deep.

Ids are strings and are assigned by the server, never by the agent.

A point has a one-line `title` (at most 200 characters, shown collapsed), an optional `detail`
in markdown, and optional `content` blocks (code, diff or image, exactly as a review has them).
A briefing holds at most 50 top-level points.

### Contract additions (sketch; names final, layout the builder's)

```tsp
enum AskKind { question, review, briefing }

model BriefingPoint {                // what the agent sends
  @minLength(1) @maxLength(200) title: string;
  detail?: string;
  content?: Block[];
}
model BriefingSection { title?: string; @minItems(1) points: BriefingPoint[]; }
model BriefingInput {
  @minLength(1) @maxLength(200) title: string;
  summary?: string;
  @minItems(1) sections: BriefingSection[];
  @minLength(1) project: string;     // same doc comment as the others
}

model Point {                        // a point as shown: BriefingPoint plus its id
  id: string;
  ...BriefingPoint;
}
model BriefingPrompt { title: string; summary?: string; sections: { title?: string; points: Point[] }[]; }
model BriefingAsk { kind: "briefing"; prompt: BriefingPrompt; ...AskCommon; }

model PointReply {                   // the person on one point: words, resolved, or both
  @minLength(1) point: string;
  text?: string;
  resolved?: boolean;
}
model Responded { outcome: "responded"; @minItems(1) points: PointReply[]; }

model PointAnswer {                  // the agent on one point
  @minLength(1) point: string;
  @minLength(1) answer: string;
  content?: Block[];
  points?: BriefingPoint[];          // sub-points this point breaks into
}
model BriefingAnswerInput { @minLength(1) askId: string; @minItems(1) answers: PointAnswer[]; }

// AgentEntry gains two optional fields, so one agent move on a briefing is one entry per point:
//   point?: string;      the point this answers
//   points?: Point[];    sub-points it added, with their assigned ids
```

`Ask`, `Reply` and `AskKind` gain the new members. Nothing existing changes shape.

### How a briefing moves

1. The agent calls **`send_briefing`**. The space opens a `briefing` ask through `open`, numbers its
   points and announces it. Retries rejoin it the same way questions and reviews do.
2. **The person's move.** They open points, write on some, mark some resolved, and send. Sending is
   one `responded` reply covering every point they touched since their last send.
   - If every point is resolved once this reply lands, the briefing **closes**. Words in that last
     reply are final notes for the agent, and it owes no answer to them.
   - Otherwise the reply must carry words on at least one point, and the move goes to the agent
     (`awaiting_agent`).
   - `dismissed` closes it without anything else. No other outcome applies to a briefing, and
     `responded` applies only to briefings.
3. **The agent's move.** The agent gets the reply as its tool result and calls **`answer_briefing`**
   with one answer for every point it owes (see the point rules), plus any other open points it
   wants to add to. The space refuses a move that leaves out an owed point, and lists the
   missing ones. Each answer becomes one `AgentEntry` tagged with its point. Sub-points get
   their ids here. The move returns to the person, and the call then waits for their next
   reply exactly as `answer_follow_up` does: as a background task where the client supports
   it, in laps otherwise. The task's turn is the last entry of the agent's move.
4. Repeat until it closes. After it closes, the agent acts on what it got and may raise a fresh
   question if something is still unclear.

### Point rules

- Resolved is the person's call alone, and it wins:
  - Resolving a point resolves every point beneath it.
  - Words sent together with `resolved: true` are a closing note. The agent gets them but owes no
    answer, and they don't count as words the agent must answer.
  - Writing on a resolved point (or anything beneath one) without `resolved: true` reopens it.
  - The agent can't reopen anything. `answer_briefing` refuses an answer on a resolved point, and
    refuses sub-points under one. If the agent has more to say, it says it on an open point or asks
    a new question once the briefing closes.
- The points the agent **owes an answer** on are those the person's last reply put words on and
  left unresolved. A reply that doesn't close the briefing must owe at least one.
- A point **needs the person** when they haven't touched it yet, when the agent answered it after
  their last word on it, or when it's a sub-point the agent just added. It is **with the agent**
  when it's owed an answer. It is **resolved** when it, or a point above it, was marked so.
- The space checks a reply against the points as folded so far: every point named exists, none
  appears twice in one reply, and each item carries words or `resolved: true`.
- The turn belongs to the whole briefing, as it does for every ask: the person sends one reply,
  the agent answers it in one move. During the agent's move the person may still **dismiss** the
  briefing (so one whose agent has gone never gets stuck), but may not send anything else. An
  `answer_briefing` that arrives after that gets the existing "this ask is closed" refusal. This
  exception applies to briefings only; questions and reviews keep today's turn rule.
- Size is checked per call, as today: each `send_briefing` and each `answer_briefing` is at most
  256 KiB, the same as `answer_follow_up`. A briefing's total isn't capped.

The fold from prompt plus thread to a tree of points and their states is a pure function in
`@loopbackhq/sdk`. The server uses it to validate, and every frontend uses it to render, so the
two can never disagree. (The server already depends on the protocol, so if importing the SDK
crosses a layering rule, the fold lives in the protocol package instead. That's the builder's
call.)

### What the agent sees

The agent sees a briefing reply as structured content (the `ToolReply`, as today). Its text form
lists each point it covers, with the point's id **and title**, what the person said, and whether
it was resolved. It ends by saying which points the agent must answer, or that the briefing is
closed. That way an agent whose context has been compacted still knows what "3.2" was.

### Tools and guidance

- `send_briefing` takes `BriefingInput`. Its description says to use it when the person asks you
  to explain or walk them through something that breaks into several points: findings, options,
  steps, a list of changes. Don't write those as a list in your reply.
- `answer_briefing` takes `BriefingAnswerInput`. It must answer every point it owes, and may break
  an open point into sub-points.
- The MCP `INSTRUCTIONS`, the Claude Code plugin's `session-context.sh`, and the reason text in
  `stop-if-asking.sh` each gain one line naming `send_briefing` for that case.
- `docs/architecture.md` (the Asks section) and the README's tool list describe briefings.

## The inbox

- **List row:** the briefing's title, its project, and how many points need the person.
- **Detail:** title, project, status, summary, then each section's points as a tree.
  - Every point starts collapsed to one line: its id, title, and a marker for _needs you_, _with
    agent_ or _resolved_.
  - Opening a point shows its detail and content, then its own thread (the person's words and the
    agent's answers, oldest first), its sub-points (indented, collapsed the same way), and a
    composer: a text box and a _Resolve_ toggle.
  - Resolved points fold into an "_n_ resolved" line at their level, which can be opened.
  - A _Next_ control jumps to the next point that needs the person.
- **Drafts:** what the person writes on each point is kept in the browser until sent, so they can
  work through a long briefing over time. They can draft while it's the agent's move. Sending is
  disabled then and shows that the agent is answering.
- **Send bar** (stays in view): _Send_ shows how many points it covers. When sending would leave
  every point resolved it reads _Finish_. There's also _Finish now_, which resolves every
  remaining point and sends, and _Dismiss_. While it's the agent's move, only _Dismiss_ stays
  enabled.
- Notifications, the tab-title count and "agent waiting" work as they do for other asks.

## Verification

Through the real entry points, not only unit tests:

- MCP tests drive `send_briefing` → a REST `responded` reply → `answer_briefing` with sub-points →
  a closing reply, through the Worker's `/mcp`, in both modes (background task and waiting
  laps). They also cover a retry rejoining, a dismiss during the agent's move followed by its
  `answer_briefing` being refused, and every refusal: an answer that misses an owed point, an
  answer on a resolved point, an unknown point, a duplicate, depth past three, a non-closing
  reply that owes nothing, and `responded` sent to a question.
- Inbox tests cover the fold, the tree, drafts, _Next_ and the send bar.
- The architecture suite stays green, and `pnpm generate:check`, typecheck, lint and test all
  pass.
- One real run: `pnpm dev`, a real MCP client sends a briefing, and the person works it in a real
  browser through two rounds with sub-points, until it closes.

## Left to the builder

- File layout and component structure in the inbox, and the exact styling (with Kumo, as the
  inbox uses now).
- The text wording of tool results and refusals, in the voice of the existing ones.
- Where the fold lives (SDK or protocol), as above.

## Decided without the person (check these)

- **The names**: ask kind `briefing`, tools `send_briefing` and `answer_briefing`, reply outcome
  `responded`. They go into the contract the hosted product builds on, so this is the cheapest
  moment to rename them.
- **The turn is per briefing, not per point.** You send once to cover everything you touched; the
  agent answers it all in one move. This is what lets briefings reuse the existing turns, tasks
  and inbox grouping. Sending per point would need a turn per point and several open tasks per
  ask, which is a different and much larger design.
- **Resolved wins**: words sent with it are a closing note, and the agent can't reopen a point.
- **You can dismiss a briefing during the agent's move.** This applies to briefings only.
- **Size is checked per call** (256 KiB), with no cap on the total.
- Top-level points are numbered straight through the briefing, not per section.
- Nesting goes at most three levels deep, at most 50 top-level points.
- Closing is automatic once everything is resolved, and words in that last reply need no answer.
- No choices on points.

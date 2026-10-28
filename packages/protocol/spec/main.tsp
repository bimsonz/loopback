import "@typespec/http";
import "@typespec/openapi";

using Http;

// The Loopback contract. Everything the HTTP API accepts or returns, the shapes MCP tools take and
// give back, and the frames the event socket sends are declared here, and only here.

/**
 * Loopback puts what an agent needs from a person in front of them and hands the reply back.
 *
 * An agent asks over MCP; a person answers through this API, usually from the web inbox. Live updates
 * arrive over the WebSocket at `/api/v1/events`, which sends a `SnapshotEvent` and then `AskEvent`s.
 */
@service(#{ title: "Loopback" })
@server("/api/v1", "Loopback API")
namespace Loopback;

// --- vocabulary -----------------------------------------------------------------------------------

/** What an agent is asking for: an answer to a question, or a verdict on something it produced. */
enum AskKind {
	question,
	review,
}

/** Where an ask stands. While it is open, it is either the person's move or the agent's. */
enum AskStatus {
	awaiting_human,
	awaiting_agent,
	closed,
}

/** Image formats an agent may upload for a review. */
union ImageType {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
}

// --- content --------------------------------------------------------------------------------------

/** Prose, copy or a plan, as GitHub-flavoured markdown. */
model MarkdownBlock {
	type: "markdown";
	@minLength(1) text: string;
}

/** Source code, shown highlighted. */
model CodeBlock {
	type: "code";
	@minLength(1) code: string;

	/** A language name the highlighter knows, such as `ts` or `python`. */
	language?: string;

	filename?: string;
}

/** A unified diff, as `git diff` prints it. */
model DiffBlock {
	type: "diff";
	@minLength(1) diff: string;
	filename?: string;
}

/** An image uploaded beforehand through an upload ticket. */
model ImageBlock {
	type: "image";
	@minLength(1) uploadId: string;
	caption?: string;
}

/** One piece of what is shown to the person. */
union Block {
	markdown: MarkdownBlock,
	code: CodeBlock,
	diff: DiffBlock,
	image: ImageBlock,
}

/** A choice offered with a question. */
model Choice {
	@minLength(1) @maxLength(80) label: string;
	description?: string;
}

// --- what agents send -----------------------------------------------------------------------------

/**
 * A question for the person, with optional choices. They may always answer in their own words. All
 * of it together may be at most 256 KiB.
 */
model QuestionInput {
	/** The question, as markdown. */
	@minLength(1) question: string;

	/** Between two and six choices, offered as buttons. */
	@minItems(2) @maxItems(6) options?: Choice[];

	/** Whether the person may pick more than one choice. */
	multiple?: boolean;

	/** Background the person needs to answer, as markdown. */
	context?: string;

	/**
	 * The project you are working in: the name of the folder at the root of its repository (the
	 * last part of `git rev-parse --show-toplevel`), or of the working directory outside one. The
	 * person works on many projects at once from one inbox; this is how they know who is asking.
	 */
	@minLength(1) project: string;
}

/**
 * Work put in front of the person for approval or feedback. All of it together may be at most
 * 256 KiB: show the part that matters, or split it into several reviews.
 */
model ReviewInput {
	@minLength(1) @maxLength(200) title: string;

	/** What is being reviewed, in order. */
	@minItems(1) content: Block[];

	/** What changed, or what to look at. */
	summary?: string;

	/** The id of the review this one revises, after changes were requested. */
	revises?: string;

	/**
	 * The project you are working in: the name of the folder at the root of its repository (the
	 * last part of `git rev-parse --show-toplevel`), or of the working directory outside one. The
	 * person works on many projects at once from one inbox; this is how they know who is asking.
	 */
	@minLength(1) project: string;
}

/** The agent's answer to a question the person asked back, with its content at most 256 KiB. */
model FollowUpInput {
	@minLength(1) askId: string;

	/** The answer, as markdown. */
	@minLength(1) answer: string;

	/** Anything new to look at alongside the answer. */
	content?: Block[];
}

/** A request for somewhere to upload an image. */
model UploadRequest {
	contentType: ImageType;
}

/** Where to upload an image, once, before it expires. */
model UploadTicket {
	uploadId: string;

	/** Send the image here with `PUT` and its `Content-Type`. No credentials needed. */
	uploadUrl: string;

	expiresAt: utcDateTime;
	maxBytes: int32;

	/** A ready-to-run command that performs the upload; replace `FILE` with the image's path. */
	command: string;
}

/** A request for the address of the person's inbox. */
model InboxRequest {
	/** An ask to open directly. Leave it out for the inbox itself. */
	askId?: string;
}

/** Where the person reads and answers everything agents ask. */
model InboxLink {
	url: string;
}

// --- what people send -----------------------------------------------------------------------------

/** An answer to a question: the choices picked, words of their own, or both. */
model Answered {
	outcome: "answered";
	selected: string[];
	text?: string;
}

/** A review approved, with an optional note. */
model Approved {
	outcome: "approved";
	note?: string;
}

/** A review sent back with feedback. */
model ChangesRequested {
	outcome: "changes_requested";
	@minLength(1) feedback: string;
}

/** A question asked back before deciding. The ask stays open until the agent answers. */
model FollowUp {
	outcome: "follow_up";
	@minLength(1) question: string;
}

/** Declined without an answer. */
model Dismissed {
	outcome: "dismissed";
}

/** What a person replies. Every outcome except `follow_up` closes the ask. */
union Reply {
	answered: Answered,
	approved: Approved,
	changes_requested: ChangesRequested,
	follow_up: FollowUp,
	dismissed: Dismissed,
}

// --- asks -----------------------------------------------------------------------------------------

/** A question as it is shown to the person. */
model QuestionPrompt {
	question: string;
	options: Choice[];
	multiple: boolean;
	context?: string;
}

/** A review as it is shown to the person. */
model ReviewPrompt {
	title: string;
	content: Block[];
	summary?: string;
}

/** A reply the person gave. */
model HumanEntry {
	author: "human";
	reply: Reply;
	at: utcDateTime;
}

/** An answer the agent gave to a question asked back. */
model AgentEntry {
	author: "agent";
	answer: string;
	content?: Block[];
	at: utcDateTime;
}

/** One turn in an ask's thread after it was opened. */
union Entry {
	human: HumanEntry,
	agent: AgentEntry,
}

/** What every ask carries, whatever its kind. */
model AskCommon {
	id: string;
	status: AskStatus;

	/** Whether an agent is following this ask right now: waiting on its call, or polling it as a background task. */
	waiting: boolean;

	project?: string;

	/** The MCP client that asked, such as `claude-code 2.1.0`. */
	client?: string;

	/** Every turn after the ask was opened, oldest first. */
	thread: Entry[];

	createdAt: utcDateTime;
	updatedAt: utcDateTime;
	closedAt?: utcDateTime;
}

/** A question an agent asked. */
model QuestionAsk {
	kind: "question";
	prompt: QuestionPrompt;
	...AskCommon;
}

/** Work an agent put up for review. */
model ReviewAsk {
	kind: "review";
	prompt: ReviewPrompt;

	/** The id of the review this one revises. */
	revises?: string;

	...AskCommon;
}

/** Something an agent needs from a person: a short thread that ends with a reply. */
union Ask {
	question: QuestionAsk,
	review: ReviewAsk,
}

/** What a blocking MCP tool returns: the reply that ended its wait. */
model ToolReply {
	askId: string;
	reply: Reply;
}

/** Open asks, newest first, and the most recently closed. */
model Snapshot {
	open: Ask[];
	recent: Ask[];
}

/** A page of closed asks, newest first. */
model AskPage {
	items: Ask[];

	/** Pass as `before` for the next page. Absent on the last page. */
	nextBefore?: utcDateTime;
}

/**
 * A one-time pass onto the event socket, for a client that cannot send headers there, as a browser
 * cannot. Offer it as the subprotocol `loopback.ticket.<ticket>` alongside `loopback.v1`. It works
 * once, within a minute, so a copy that turns up in a log is of no use to anyone.
 */
model EventTicket {
	ticket: string;
	expiresAt: utcDateTime;
}

/** Who the caller is. */
model Whoami {
	space: string;
}

/** A stored upload. */
model UploadReceipt {
	uploadId: string;
	contentType: ImageType;
	size: int32;
}

// --- event socket frames --------------------------------------------------------------------------

/** The first frame on the event socket, and the state to start from. */
model SnapshotEvent {
	type: "snapshot";
	snapshot: Snapshot;
}

/** An ask was opened, or changed: a new turn, a close, or an agent starting or stopping following it. */
model AskEvent {
	type: "ask.opened" | "ask.updated";
	ask: Ask;
}

/** A frame on the event socket. */
union ServerEvent {
	snapshot: SnapshotEvent,
	ask: AskEvent,
}

// --- errors ---------------------------------------------------------------------------------------

/** Why a request was refused. */
model Problem {
	/** A stable, machine-readable reason, such as `ask.closed`. */
	code: string;

	message: string;
}

@error
model Unauthorized {
	@statusCode statusCode: 401;
	@body body: Problem;
}

@error
model NotFound {
	@statusCode statusCode: 404;
	@body body: Problem;
}

@error
model Conflict {
	@statusCode statusCode: 409;
	@body body: Problem;
}

@error
model Gone {
	@statusCode statusCode: 410;
	@body body: Problem;
}

@error
model TooLarge {
	@statusCode statusCode: 413;
	@body body: Problem;
}

@error
model Unprocessable {
	@statusCode statusCode: 422;
	@body body: Problem;
}

// --- operations -----------------------------------------------------------------------------------

@route("/whoami")
@useAuth(BearerAuth)
interface Session {
	/** The space the credentials open. */
	@get whoami(): Whoami | Unauthorized;
}

@route("/events/tickets")
@useAuth(BearerAuth)
interface EventTickets {
	/** A one-time pass onto the event socket, `/api/v1/events`. */
	@post issue(): {
		@statusCode statusCode: 201;
		@body body: EventTicket;
	} | Unauthorized;
}

@route("/snapshot")
@useAuth(BearerAuth)
interface Snapshots {
	/** Every open ask and the fifty most recently closed: what an inbox starts from. */
	@get read(): Snapshot | Unauthorized;
}

@route("/asks")
@useAuth(BearerAuth)
interface Asks {
	/** Closed asks, newest first, for paging back through history. */
	@get list(
		/** Only asks closed before this moment. */
		@query before?: utcDateTime,

		@query @minValue(1) @maxValue(100) limit?: int32,
	): AskPage | Unauthorized;

	@get read(@path id: string): Ask | NotFound | Unauthorized;

	/**
	 * Reply to an ask. Refused with 409 when the ask is closed or it is the agent's turn, and with
	 * 422 when the reply does not fit: `answered` is for questions and needs a choice or text, with
	 * choices among those offered and only one unless several are allowed; `approved` and
	 * `changes_requested` are for reviews.
	 */
	@route("/{id}/reply")
	@post
	reply(@path id: string, @body reply: Reply): Ask | NotFound | Conflict | Unprocessable | Unauthorized;
}

@route("/files")
@useAuth(BearerAuth)
interface Files {
	/** An uploaded image. */
	@get read(@path uploadId: string): {
		@header contentType: ImageType;
		@body body: bytes;
	} | NotFound | Unauthorized;
}

@route("/uploads")
@useAuth(NoAuth)
interface Uploads {
	/**
	 * Store an image against an upload ticket. The URL is the credential: it works once, for
	 * fifteen minutes, for the declared content type, up to the ticket's `maxBytes`.
	 */
	@put store(
		@path spaceId: string,
		@path token: string,
		@header contentType: string,
		@body body: bytes,
	): {
		@statusCode statusCode: 201;
		@body body: UploadReceipt;
	} | NotFound | Gone | TooLarge | Unprocessable;
}

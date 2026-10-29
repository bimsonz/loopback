import { Schema } from "effect";

/** No ask with this id in the space. */
export class AskNotFound extends Schema.TaggedError<AskNotFound>()("AskNotFound", {
	askId: Schema.String,
}) {}

/** The ask has already been closed by a reply. */
export class AskClosed extends Schema.TaggedError<AskClosed>()("AskClosed", {
	askId: Schema.String,
}) {}

/** The move belongs to the other party: a reply while the agent owes an answer, or the reverse. */
export class NotYourTurn extends Schema.TaggedError<NotYourTurn>()("NotYourTurn", {
	askId: Schema.String,
	turn: Schema.Literals(["human", "agent"]),
}) {}

/** A reply that does not fit the ask it answers. */
export class ReplyInvalid extends Schema.TaggedError<ReplyInvalid>()("ReplyInvalid", {
	reason: Schema.String,
}) {}

/** Review content that refers to something the space does not hold. */
export class ContentInvalid extends Schema.TaggedError<ContentInvalid>()("ContentInvalid", {
	reason: Schema.String,
}) {}

/** No event ticket matches: it was never issued, has been used, or has expired. */
export class TicketInvalid extends Schema.TaggedError<TicketInvalid>()("TicketInvalid", {}) {}

/** No upload, or upload ticket, matches. */
export class UploadNotFound extends Schema.TaggedError<UploadNotFound>()("UploadNotFound", {}) {}

/** The upload ticket has expired or was already used. */
export class UploadExpired extends Schema.TaggedError<UploadExpired>()("UploadExpired", {}) {}

/** The upload's body ended before, or ran past, the length it declared. */
export class UploadIncomplete extends Schema.TaggedError<UploadIncomplete>()(
	"UploadIncomplete",
	{},
) {}

/** The upload's content type is not the one its ticket was issued for. */
export class UploadRejected extends Schema.TaggedError<UploadRejected>()("UploadRejected", {
	reason: Schema.String,
}) {}

/**
 * The deployment declined to open an ask or an upload, as a host's limits can: the space itself never
 * declines. The reason is written for the agent, and says what would let it through.
 */
export class Declined extends Schema.TaggedError<Declined>()("Declined", {
	reason: Schema.String,
}) {}

/** The request carries no credentials the gate accepts. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
	reason: Schema.String,
}) {}

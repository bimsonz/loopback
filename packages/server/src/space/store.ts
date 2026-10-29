import type { AskStatus, Entry, ImageType } from "@loopbackhq/protocol";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { AskRecord, EntryRecord } from "../domain/ask.ts";

interface AskRow {
	readonly id: string;
	readonly kind: "question" | "review";
	readonly key: string;
	readonly status: AskStatus;
	readonly prompt: string;
	readonly project: string | null;
	readonly client: string | null;
	readonly raisedBy: string | null;
	readonly revises: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
	readonly lastWaitedAt: string | null;
}

interface EntryRow {
	readonly askId: string;
	readonly seq: number;
	readonly body: string;
	readonly deliveredAt: string | null;
}

const askOf = (row: AskRow): AskRecord => {
	const head = {
		id: row.id,
		key: row.key,
		status: row.status,
		project: row.project,
		client: row.client,
		raisedBy: row.raisedBy === null ? null : JSON.parse(row.raisedBy),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		closedAt: row.closedAt,
		lastWaitedAt: row.lastWaitedAt,
	};
	return row.kind === "question"
		? { ...head, kind: "question", prompt: JSON.parse(row.prompt) }
		: { ...head, kind: "review", prompt: JSON.parse(row.prompt), revises: row.revises };
};

const entryOf = (row: EntryRow): EntryRecord => ({
	askId: row.askId,
	seq: row.seq,
	entry: JSON.parse(row.body),
	deliveredAt: row.deliveredAt,
});

/** Persistence for asks and their threads. Storage failing is a defect, not an error to handle. */
export class AskStore extends Context.Service<
	AskStore,
	{
		readonly find: (id: string) => Effect.Effect<Option.Option<AskRecord>>;
		/** The newest ask with this key, still open or holding an undelivered reply, waited on since `since`. */
		readonly findRetry: (key: string, since: string) => Effect.Effect<Option.Option<AskRecord>>;
		readonly insert: (record: AskRecord) => Effect.Effect<void>;
		readonly setStatus: (id: string, status: AskStatus, at: string) => Effect.Effect<void>;
		readonly touchWaited: (id: string, at: string) => Effect.Effect<void>;
		readonly thread: (id: string) => Effect.Effect<EntryRecord[]>;
		readonly threads: (ids: readonly string[]) => Effect.Effect<Map<string, EntryRecord[]>>;
		readonly append: (askId: string, entry: Entry) => Effect.Effect<EntryRecord>;
		/** The newest human entry not yet handed to an agent. */
		readonly undelivered: (askId: string) => Effect.Effect<Option.Option<EntryRecord>>;
		readonly markDelivered: (askId: string, seq: number, at: string) => Effect.Effect<void>;
		/** Marks every human entry on the ask as handed to the agent. */
		readonly markAllDelivered: (askId: string, at: string) => Effect.Effect<void>;
		/** Every open ask, newest first. */
		readonly open: Effect.Effect<AskRecord[]>;
		/** Closed asks, newest first, closed before `before` when given. */
		readonly closed: (before: string | undefined, limit: number) => Effect.Effect<AskRecord[]>;
		/** Records that an agent stopped following the reply to its turn `afterSeq`. */
		readonly cancelTask: (askId: string, afterSeq: number, at: string) => Effect.Effect<void>;
		readonly taskCancelledAt: (
			askId: string,
			afterSeq: number,
		) => Effect.Effect<Option.Option<string>>;
		/** Runs `effect` as one storage transaction. */
		readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("loopback/AskStore") {
	static readonly layer = Layer.effect(
		AskStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const asks = (statement: Effect.Effect<ReadonlyArray<AskRow>, unknown>) =>
				statement.pipe(
					Effect.map((rows) => rows.map(askOf)),
					Effect.orDie,
				);
			const columns = sql.literal(`
				id, kind, key, status, prompt, project, client, raised_by AS raisedBy, revises,
				created_at AS createdAt, updated_at AS updatedAt, closed_at AS closedAt,
				last_waited_at AS lastWaitedAt
			`);
			const entryColumns = sql.literal("ask_id AS askId, seq, body, delivered_at AS deliveredAt");
			const first = <A>(effect: Effect.Effect<A[]>) =>
				Effect.map(effect, (rows) => Option.fromNullishOr(rows[0]));

			return AskStore.of({
				find: (id) => first(asks(sql<AskRow>`SELECT ${columns} FROM asks WHERE id = ${id}`)),

				findRetry: (key, since) =>
					first(
						asks(sql<AskRow>`
							SELECT ${columns} FROM asks
							WHERE key = ${key}
								AND last_waited_at >= ${since}
								AND (
									status != 'closed'
									OR EXISTS (
										SELECT 1 FROM entries
										WHERE entries.ask_id = asks.id
											AND entries.author = 'human'
											AND entries.delivered_at IS NULL
									)
								)
							ORDER BY created_at DESC
							LIMIT 1
						`),
					),

				insert: (record) =>
					sql`INSERT INTO asks ${sql.insert({
						id: record.id,
						kind: record.kind,
						key: record.key,
						status: record.status,
						prompt: JSON.stringify(record.prompt),
						project: record.project,
						client: record.client,
						raised_by: record.raisedBy === null ? null : JSON.stringify(record.raisedBy),
						revises: record.kind === "review" ? record.revises : null,
						created_at: record.createdAt,
						updated_at: record.updatedAt,
						closed_at: record.closedAt,
						last_waited_at: record.lastWaitedAt,
					})}`.pipe(Effect.asVoid, Effect.orDie),

				setStatus: (id, status, at) =>
					sql`
						UPDATE asks
						SET status = ${status},
							updated_at = ${at},
							closed_at = ${status === "closed" ? at : null}
						WHERE id = ${id}
					`.pipe(Effect.asVoid, Effect.orDie),

				touchWaited: (id, at) =>
					sql`UPDATE asks SET last_waited_at = ${at} WHERE id = ${id}`.pipe(
						Effect.asVoid,
						Effect.orDie,
					),

				thread: (id) =>
					sql<EntryRow>`SELECT ${entryColumns} FROM entries WHERE ask_id = ${id} ORDER BY seq`.pipe(
						Effect.map((rows) => rows.map(entryOf)),
						Effect.orDie,
					),

				// The ids travel as one JSON parameter: SQLite in a Durable Object binds at most 100.
				threads: (ids) =>
					ids.length === 0
						? Effect.succeed(new Map())
						: sql<EntryRow>`
								SELECT ${entryColumns} FROM entries
								WHERE ask_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
								ORDER BY ask_id, seq
							`.pipe(
								Effect.map((rows) => {
									const byAsk = new Map<string, EntryRecord[]>();
									for (const row of rows) {
										const list = byAsk.get(row.askId) ?? [];
										list.push(entryOf(row));
										byAsk.set(row.askId, list);
									}
									return byAsk;
								}),
								Effect.orDie,
							),

				append: (askId, entry) =>
					Effect.gen(function* () {
						const [row] = yield* sql<{ readonly next: number }>`
							SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries WHERE ask_id = ${askId}
						`;
						const seq = row?.next ?? 1;
						yield* sql`INSERT INTO entries ${sql.insert({
							ask_id: askId,
							seq,
							author: entry.author,
							body: JSON.stringify(entry),
							delivered_at: null,
						})}`;
						return { askId, seq, entry, deliveredAt: null };
					}).pipe(Effect.orDie),

				undelivered: (askId) =>
					sql<EntryRow>`
						SELECT ${entryColumns} FROM entries
						WHERE ask_id = ${askId} AND author = 'human' AND delivered_at IS NULL
						ORDER BY seq DESC
						LIMIT 1
					`.pipe(
						Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), entryOf)),
						Effect.orDie,
					),

				markDelivered: (askId, seq, at) =>
					sql`
						UPDATE entries SET delivered_at = ${at}
						WHERE ask_id = ${askId} AND seq = ${seq} AND delivered_at IS NULL
					`.pipe(Effect.asVoid, Effect.orDie),

				markAllDelivered: (askId, at) =>
					sql`
						UPDATE entries SET delivered_at = ${at}
						WHERE ask_id = ${askId} AND author = 'human' AND delivered_at IS NULL
					`.pipe(Effect.asVoid, Effect.orDie),

				open: asks(
					sql<AskRow>`SELECT ${columns} FROM asks WHERE status != 'closed' ORDER BY created_at DESC`,
				),

				closed: (before, limit) =>
					asks(
						before === undefined
							? sql<AskRow>`
									SELECT ${columns} FROM asks WHERE status = 'closed'
									ORDER BY closed_at DESC LIMIT ${limit}
								`
							: sql<AskRow>`
									SELECT ${columns} FROM asks WHERE status = 'closed' AND closed_at < ${before}
									ORDER BY closed_at DESC LIMIT ${limit}
								`,
					),

				cancelTask: (askId, afterSeq, at) =>
					sql`
						INSERT OR IGNORE INTO task_cancellations (ask_id, after_seq, cancelled_at)
						VALUES (${askId}, ${afterSeq}, ${at})
					`.pipe(Effect.asVoid, Effect.orDie),

				taskCancelledAt: (askId, afterSeq) =>
					sql<{ readonly cancelledAt: string }>`
						SELECT cancelled_at AS cancelledAt FROM task_cancellations
						WHERE ask_id = ${askId} AND after_seq = ${afterSeq}
					`.pipe(
						Effect.map((rows) =>
							Option.map(Option.fromNullishOr(rows[0]), (row) => row.cancelledAt),
						),
						Effect.orDie,
					),

				transaction: (effect) =>
					sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die)),
			});
		}),
	);
}

/** Persistence for event tickets, kept only by their hash. */
export class TicketStore extends Context.Service<
	TicketStore,
	{
		readonly insert: (tokenHash: string, actorId: string, expiresAt: string) => Effect.Effect<void>;
		/** Removes the ticket and gives back who it was for and until when; none if it is unknown. */
		readonly take: (
			tokenHash: string,
		) => Effect.Effect<Option.Option<{ readonly actorId: string; readonly expiresAt: string }>>;
		/** Forgets tickets that expired before `at`. */
		readonly purge: (at: string) => Effect.Effect<void>;
	}
>()("loopback/TicketStore") {
	static readonly layer = Layer.effect(
		TicketStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return TicketStore.of({
				insert: (tokenHash, actorId, expiresAt) =>
					sql`INSERT INTO event_tickets ${sql.insert({
						token_hash: tokenHash,
						actor_id: actorId,
						expires_at: expiresAt,
					})}`.pipe(Effect.asVoid, Effect.orDie),
				take: (tokenHash) =>
					sql<{ readonly actorId: string; readonly expiresAt: string }>`
						DELETE FROM event_tickets WHERE token_hash = ${tokenHash}
						RETURNING actor_id AS actorId, expires_at AS expiresAt
					`.pipe(
						Effect.map((rows) => Option.fromNullishOr(rows[0])),
						Effect.orDie,
					),
				purge: (at) =>
					sql`DELETE FROM event_tickets WHERE expires_at < ${at}`.pipe(Effect.asVoid, Effect.orDie),
			});
		}),
	);
}

export interface UploadRecord {
	readonly id: string;
	readonly tokenHash: string;
	readonly contentType: ImageType;
	readonly maxBytes: number;
	readonly status: "pending" | "claimed" | "stored";
	readonly size: number | null;
	readonly createdAt: string;
	readonly expiresAt: string;
}

/** Persistence for upload tickets and the uploads they produce. */
export class UploadStore extends Context.Service<
	UploadStore,
	{
		readonly insert: (record: UploadRecord) => Effect.Effect<void>;
		readonly find: (id: string) => Effect.Effect<Option.Option<UploadRecord>>;
		readonly findByToken: (tokenHash: string) => Effect.Effect<Option.Option<UploadRecord>>;
		readonly setStatus: (
			id: string,
			status: UploadRecord["status"],
			size: number | null,
		) => Effect.Effect<void>;
	}
>()("loopback/UploadStore") {
	static readonly layer = Layer.effect(
		UploadStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = sql.literal(`
				id, token_hash AS tokenHash, content_type AS contentType, max_bytes AS maxBytes,
				status, size, created_at AS createdAt, expires_at AS expiresAt
			`);
			const one = (statement: Effect.Effect<ReadonlyArray<UploadRecord>, unknown>) =>
				statement.pipe(
					Effect.map((rows) => Option.fromNullishOr(rows[0])),
					Effect.orDie,
				);
			return UploadStore.of({
				insert: (record) =>
					sql`INSERT INTO uploads ${sql.insert({
						id: record.id,
						token_hash: record.tokenHash,
						content_type: record.contentType,
						max_bytes: record.maxBytes,
						status: record.status,
						size: record.size,
						created_at: record.createdAt,
						expires_at: record.expiresAt,
					})}`.pipe(Effect.asVoid, Effect.orDie),
				find: (id) => one(sql<UploadRecord>`SELECT ${columns} FROM uploads WHERE id = ${id}`),
				findByToken: (tokenHash) =>
					one(sql<UploadRecord>`SELECT ${columns} FROM uploads WHERE token_hash = ${tokenHash}`),
				setStatus: (id, status, size) =>
					sql`UPDATE uploads SET status = ${status}, size = ${size} WHERE id = ${id}`.pipe(
						Effect.asVoid,
						Effect.orDie,
					),
			});
		}),
	);
}

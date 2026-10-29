import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect } from "effect";
import { SqlClient, Migrator } from "effect/sql";

/** The space's schema, applied in order when its object starts. Never edit one that has shipped. */
export const migrations = SqliteMigrator.layer({
	loader: Migrator.fromRecord({
		"0001_asks": Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				CREATE TABLE asks (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					key TEXT NOT NULL,
					status TEXT NOT NULL,
					prompt TEXT NOT NULL,
					project TEXT,
					client TEXT,
					revises TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					closed_at TEXT,
					last_waited_at TEXT
				)
			`;
			yield* sql`CREATE INDEX asks_by_key ON asks (key)`;
			yield* sql`CREATE INDEX asks_by_status ON asks (status, created_at)`;
			yield* sql`CREATE INDEX asks_by_closed_at ON asks (closed_at)`;
			yield* sql`
				CREATE TABLE entries (
					ask_id TEXT NOT NULL REFERENCES asks (id),
					seq INTEGER NOT NULL,
					author TEXT NOT NULL,
					body TEXT NOT NULL,
					delivered_at TEXT,
					PRIMARY KEY (ask_id, seq)
				)
			`;
			yield* sql`
				CREATE TABLE uploads (
					id TEXT PRIMARY KEY,
					token_hash TEXT NOT NULL UNIQUE,
					content_type TEXT NOT NULL,
					max_bytes INTEGER NOT NULL,
					status TEXT NOT NULL,
					size INTEGER,
					created_at TEXT NOT NULL,
					expires_at TEXT NOT NULL
				)
			`;
		}),
		"0002_task_cancellations": Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// An agent's background task follows the reply to one of its turns. Cancelling it is
			// remembered, so the task keeps answering "cancelled" rather than going unknown.
			yield* sql`
				CREATE TABLE task_cancellations (
					ask_id TEXT NOT NULL REFERENCES asks (id),
					after_seq INTEGER NOT NULL,
					cancelled_at TEXT NOT NULL,
					PRIMARY KEY (ask_id, after_seq)
				)
			`;
		}),
		"0003_event_tickets": Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// One-time passes onto the event socket, for browsers, which cannot send headers there.
			yield* sql`
				CREATE TABLE event_tickets (
					token_hash TEXT PRIMARY KEY,
					actor_id TEXT NOT NULL,
					expires_at TEXT NOT NULL
				)
			`;
		}),
		"0004_raised_by": Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// Whose agent asked, as the gate named them; asks opened before it was recorded have none.
			yield* sql`ALTER TABLE asks ADD COLUMN raised_by TEXT`;
		}),
	}),
});

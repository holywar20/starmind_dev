import { randomUUID } from 'crypto';

import { Agent, type AgentSummary, type SerializedAgent, type ToolDef } from '@kcd/core';

import { Door, isOk, unreached, type DoorReply } from '../Door';
import type { ToolDefinition, ToolResult } from '../mcp';
import { testbedTools } from './testbed';
import { driveTools } from './drive';

/** How long a wait runs before giving up, and how often it looks. The default sits just under the usual
 *  180s MCP client timeout, because a wait that outlives its caller reports its answer to nobody. One
 *  second between looks is far finer than a 30-90s turn needs and costs two loopback reads at most. */
const DEFAULT_WAIT_MS = 170_000;
const POLL_MS         = 1_000;   // the CEILING on the interval, not the interval itself

/** Where every session this rig spawns is filed. A test space, kept apart from a person's own work by
 *  construction rather than by anyone remembering to move things afterwards. */
const HARNESS_FOLDER = 'Harness Agents';

/**
 * The HOT tools — everything that needs a running Starmind.
 *
 * These are the nine that used to live INSIDE the application as an in-process tool table. Nothing
 * about what they do has changed; what changed is which side of the process boundary they run on, and
 * that single move is the whole of Arc 1. Re-read the cold-tools header for the other half.
 *
 * ── STILL THIN CALLERS, UNDER A COST THAT WENT UP ───────────────────────────────────────────────
 *
 * The founding rule of this surface was that every handler is argument-shaping over a bus verb the
 * RENDERER already calls, so that a test exercises the road the product ships rather than a private
 * one built for testing. That rule was FREE when a verb was a function call in the same process. It is
 * not free now — every verb is an HTTP round trip on loopback.
 *
 * IT IS KEPT ANYWAY, and the temptation it resists is worth naming because it will recur: batching two
 * verbs into one app-side helper, or caching app state on this side to save a hop, is how a second
 * implementation of the product gets born inside its own test rig. `spawn` costs three round trips. On
 * loopback that is single-digit milliseconds against a turn that takes thirty to ninety seconds, so
 * the optimization would buy nothing measurable and cost the only property that makes these tools
 * evidence.
 *
 * The corollary is unchanged and is now MORE useful, not less: anything this file cannot do through an
 * existing verb is a MISSING VERB, not licence to reach past it. Out of process, that signal got
 * sharper — in-process it was possible to quietly reach for a main-side object and never notice.
 *
 * ── FIRE AND FORGET, BECAUSE AGENTS WORK IN TURNS ───────────────────────────────────────────────
 *
 * A turn takes 30–90 seconds. Nothing here waits for one. `chat_send` is an emit-and-go bus event, so
 * these tools return the moment a turn is ACCEPTED, carrying the session id and a traceId, and the
 * caller reads the outcome afterwards from `get_turns` plus the trace files.
 *
 * ── WHAT THE MOVE COST, STATED PLAINLY ──────────────────────────────────────────────────────────
 *
 * In process, a reply from any of these tools was itself proof the app was alive. That is gone: this
 * server answers whether or not Starmind is running. `dev_status` is now the ONLY tool whose success
 * is a statement about the app, which is why it is the one to call first and why every other tool
 * reports being unable to reach the app as a distinct, named outcome rather than as a failure.
 */

/** JSON text is the return currency — every consumer here is a program or an agent asserting on
 *  fields, and a sentence would have to be parsed back. */
function ok( value: unknown ): ToolResult {
	return { content: [ { type: 'text', text: JSON.stringify( value, null, 2 ) } ] };
}

/** Refusals stay PROSE and say what would fix them — the one place this surface talks to a reader
 *  rather than a parser, and the reader is usually about to retry. */
function fail( reason: string ): ToolResult {
	return { content: [ { type: 'text', text: reason } ], isError: true };
}

/**
 * Turn any non-ok door reply into the tool's refusal, with the outcome kept intact.
 *
 * THE POINT IS THAT THESE DO NOT COLLAPSE. "The app is not running", "no service serves that verb" and
 * "the verb ran and threw" are three different things to go and fix, and a caller — human or agent —
 * decides what to do next from precisely that distinction. An unreached call additionally says NOTHING
 * WAS TESTED, because the most expensive mistake available here is reading a transport failure as a
 * finding about the app.
 */
function refuse( reply: DoorReply, tool: string ): ToolResult {
	const detail = 'detail' in reply ? reply.detail : '';
	if ( unreached( reply ) ) {
		return fail( `${ tool }: could not reach the app [ ${ reply.outcome } ]. NOTHING WAS TESTED — this is a fact about the connection, not about Starmind.\n\n${ detail }` );
	}
	// ── A SEAL IS NOT A FAULT, and it gets its own sentence so nobody spends an hour repairing it. Every
	// other refusal here describes something that went wrong and invites a fix; this one describes the
	// system working. Left under the generic wording, an agent reads "did not succeed", restarts the app,
	// checks the token, and re-runs — chasing a boundary that is behaving exactly as designed.
	if ( reply.outcome === 'sealed' ) {
		return fail( `${ tool }: REFUSED ON PURPOSE [ sealed ] on \`${ reply.verb }\`. Nothing is broken and there is nothing to repair — this door is closed to that channel by design, and it will answer the same way every time.\n\n${ detail }` );
	}
	return fail( `${ tool }: the app answered and the call did not succeed [ ${ reply.outcome } ] on \`${ reply.verb }\`.\n\n${ detail }` );
}

/** Ask one verb and hand back either its value or a finished refusal. The shape every tool below opens
 *  with, so the branch is written once rather than nine times with one of them subtly different. */
async function verb( name: string, tool: string, ...args: unknown[] ): Promise<{ value: unknown } | { refusal: ToolResult }> {
	const reply = await Door.request( name, ...args );
	if ( !isOk( reply ) ) return { refusal: refuse( reply, tool ) };
	return { value: reply.value };
}

/**
 * PROJECT a reply down to named top-level fields, and always say how big the whole one was.
 *
 * ── WHY THIS SITS AT THE DOOR AND NOT IN THE APP ────────────────────────────────────────────────
 *
 * `read_state` and `write_state` are pass-throughs on purpose: they speak the envelope the RENDERER
 * speaks, through the same gate, so what a run asserts on is the road the product ships rather than a
 * private one built for testing. That property is the whole reason this lane is trustworthy and it is
 * not up for negotiation here. Nothing below reshapes a channel, and no channel is told this exists.
 *
 * What differs is the READER. The renderer receives its reply into a process with memory, keeps the
 * parts it draws with and drops the rest. This door delivers one into a CONTEXT WINDOW, where a
 * megabyte is not merely large — it is SPENT, irreversibly, before the caller has any chance to
 * decline it. `agent_store.create` answers with the whole agent graph because the composer genuinely
 * wants a hydrated Agent back ( its own doc calls it "the one write that returns its product, because
 * the caller needs the id" ). `models.roster` carries the Models panel's entire join because that
 * panel draws every column of it. Both are RIGHT for their consumer and ruinous for this one, and the
 * difference between them is TRANSCRIPTION, not semantics — which is exactly why the fix belongs on
 * the transcribing side.
 *
 * ── AN UNNARROWED REPLY OVER THE CEILING IS WITHHELD ────────────────────────────────────────────
 *
 * Omit `fields` and the value is transcribed whole — up to `REPLY_CEILING`. Past it the value is left out
 * and `withheld` says why, beside the `bytes` and `keys` a narrow call needs. A client fails a wide reply
 * TWICE OVER: past its inline limit it spills the reply to a file the caller must go and search, and far
 * past that it closes the connection, which reads as a dead server rather than as a question asked too
 * wide. The ceiling sits under the FIRST, so neither is reached ( bug-report-20 ). A call that names
 * `fields` has said what it wants and is transcribed as asked.
 *
 * ── SIZE RIDES WHETHER OR NOT ANYONE ASKED FOR IT ───────────────────────────────────────────────
 *
 * `bytes` is on every reply and `keys` names the shape that was on offer. An agent that did not know a
 * read was expensive now finds out by making it once, and holds the vocabulary to ask narrowly the
 * next time. Without them it finds out by running out of context, which is a fact learned too late to
 * act on. Same discipline as everything else on this surface: expensive and cheap must not arrive
 * wearing one value.
 *
 * A NAMED FIELD THE ROWS DO NOT HAVE COMES BACK AS `missing`. A misspelling would otherwise project to
 * `{}` — indistinguishable from a row that legitimately holds nothing, which is the same collapse the
 * four pull outcomes were separated to avoid, re-entering one layer up.
 */
interface Projection {
	value:   unknown;
	/** Size of the WHOLE value as the door transcribes it, before any projection — in characters despite the
	 *  name, because characters are what a context pays for. Always present. */
	bytes:   number;
	/** Every top-level field that was available, read off the first row of a list. */
	keys:    string[] | undefined;
	/** Named in `fields`, served by nothing. A caller bug, stated rather than folded to empty. */
	missing: string[] | undefined;
	/** Why `value` was left out — an unnarrowed reply over `REPLY_CEILING`. Absent whenever it was not. */
	withheld: string | undefined;
}

/** The largest unnarrowed reply the door transcribes, in characters as transcribed. Set against the client's
 *  INLINE limit ( 25k tokens by default; replies of 92,974 and 99,305 characters were refused ), with margin
 *  for JSON that tokenizes densely. */
const REPLY_CEILING = 60_000;

/** The ceiling as every doc on this surface states it, built from the number so the prose cannot drift from it. */
const CEILING_TEXT = `${ REPLY_CEILING.toLocaleString( 'en-US' ) } characters as transcribed`;

/**
 * The diagnostic INDEX of the surface — every command by name, lane and description, its schema left out.
 *
 * A schema is an authoring fact that `describe_surface` serves by address, and the commands' schemas were most
 * of this reply — enough that it arrived past what a client carries inline ( bug-report-20 ). The reply says
 * what it dropped and where to get it, because a short list that reads as complete is worse than a long one.
 * Read FRESH on every call, never through `Surface`'s cache: `served` is worth reading only because it is live.
 */
function verbIndex( value: unknown ): unknown {
	if ( !value || typeof value !== 'object' ) return value;
	const whole = value as Record<string, unknown>;
	if ( !Array.isArray( whole[ 'commands' ] ) ) return value;
	return {
		...whole,
		commands: ( whole[ 'commands' ] as Record<string, unknown>[] ).map( withoutSchema ),
		schemas:  'Omitted from every command here. describe_surface { address: "emit:<name>" } returns one in full.'
	};
}

function withoutSchema( command: Record<string, unknown> ): Record<string, unknown> {
	const { schema: _schema, ...rest } = command;
	return rest;
}

function project( value: unknown, fields: unknown ): Projection {
	// AS TRANSCRIBED, not compacted: `ok()` indents, and indentation nearly doubles a real reply. Read off the
	// compact form, the ceiling passed replies the client then refused.
	const bytes = JSON.stringify( value ?? null, null, 2 )?.length ?? 0;
	const names = Array.isArray( fields ) ? fields.filter( ( f ): f is string => typeof f === 'string' ) : [];

	// The shape on offer, read off the FIRST ROW of a list: every fat read on this lane answers with a
	// homogeneous list, and what a caller needs named is one row's columns, not the list's index.
	const sample = Array.isArray( value ) ? value[ 0 ] : value;
	const keys   = sample && typeof sample === 'object' ? Object.keys( sample as object ) : undefined;

	if ( !names.length && bytes > REPLY_CEILING ) {
		const ask = keys
			? 'Pass `fields` naming what you need from `keys`.'
			: 'It has no fields to narrow by — reach the part you need through a narrower op.';
		return { value: undefined, bytes, keys, missing: undefined, withheld: `Not transcribed: ${ bytes } characters as transcribed is over the ${ REPLY_CEILING }-character ceiling for a reply that names no fields. ${ ask }` };
	}
	if ( !names.length ) return { value, bytes, keys, missing: undefined, withheld: undefined };

	const missing = keys ? names.filter( ( n ) => !keys.includes( n ) ) : [];

	const pick = ( row: unknown ): unknown => {
		if ( !row || typeof row !== 'object' ) return row;
		const out: Record<string, unknown> = {};
		for ( const n of names ) if ( n in ( row as object ) ) out[ n ] = ( row as Record<string, unknown> )[ n ];
		return out;
	};

	return {
		value:    Array.isArray( value ) ? value.map( pick ) : pick( value ),
		bytes,
		keys,
		missing:  missing.length ? missing : undefined,
		withheld: undefined
	};
}

/** The `fields` parameter, written once — three tools offer it and a drifting description would be
 *  three subtly different promises about one mechanism. */
const FIELDS_PARAM = {
	type:        'array',
	items:       { type: 'string' },
	description: 'Optional top-level field names to keep. The reply is projected down to these before it is written out — the channel is unaffected. Omit it and the whole value is transcribed unless it is over ' + CEILING_TEXT + ', when it is withheld with a `withheld` note. `bytes` always reports the size of the WHOLE value and `keys` names every field that was available, so one wide call teaches the narrow one.'
} as const;

/** The fields this surface reads off a session row. Named locally rather than importing the SDK's
 *  `Session`, because what crosses the door is the SERIALIZED form and typing it as the live class
 *  would claim behaviour that is not on the wire. */
interface SessionRef {
	id:         string;
	agentId:    string;
	title?:     string | null;
	status?:    string;
	turnCount?: number;
}

/**
 * Resolve an agent reference to a REHYDRATED Agent, by id or name.
 *
 * Out of process, so it takes the renderer's road: resolve the name to a roster row, then fetch that one agent WHOLE through `agent_store.get` and hydrate the wire form. The row is identity only and is thrown away here — every caller wants the agent, and a caller reading the row for anything else would be reading a subset that does not say it is one.
 * `agent_store.live` is no use from here — it hands over the canonical object, and an object does not
 * cross a process boundary.
 *
 * BY ID, NAME, OR A NEAR MISS — the app's own resolver ( `agent_store.resolve`, plan agents-own-behaviour task 70 ).
 * A test that silently ran as the wrong agent is the defect this surface exists to stop, so an AMBIGUOUS name is
 * refused with the candidates rather than chosen for; only a reference that lands on exactly one agent runs.
 *
 * The matched SUMMARY rides back beside the agent. It is where the authored lens paths live —
 * `describe_agent` reports them without a second trip.
 */
async function resolveAgent( ref: string, tool: string ): Promise<{ agent: Agent } | { refusal: ToolResult }> {
	const resolved = await verb( 'agent_store.resolve', tool, ref );
	if ( 'refusal' in resolved ) return resolved;

	const answer = resolved.value as { status: string; match?: AgentSummary; message?: string } | null;
	if ( !answer || answer.status !== 'found' || !answer.match ) {
		return { refusal: fail( `${ tool }: ${ answer?.message ?? `no agent matches "${ ref }".` } Call list_sessions to see them.` ) };
	}
	const match = answer.match;

	const got = await verb( 'agent_store.get', tool, match.id );
	if ( 'refusal' in got ) return got;
	if ( !got.value ) {
		return { refusal: fail( `${ tool }: agent "${ match.name }" ( ${ match.id } ) was on the roster but gone when fetched — it was deleted in between. The app answered; this is not a connection problem.` ) };
	}
	const agent = Agent.fromSerialized( got.value as SerializedAgent );

	// ── THE WIRE FORM IS NOT THE WHOLE AGENT, AND ONE FIELD DOWNSTREAM PROVES IT ──
	// `toolDefs` rides `bindEnv`, not `serializeForWire`, so a freshly rehydrated agent has none — and
	// `suggestedToolNames()` reads the DEFS rather than the mode map, precisely so a mode left behind for
	// a tool no longer served cannot name a tool that is not there. Without this bind the turn goes out
	// with an EMPTY tool surface for an agent that declares a full one, and nothing anywhere errors.
	//
	// THE RENDERER DOES EXACTLY THIS, which keeps the thin-caller rule intact: its agent store pulls
	// `mcp_store.tools` and flat-maps the servers into one list before binding. Same channel, same shape,
	// same one call — available out here only because the pull lane exists at all.
	//
	// A FAILED PULL REFUSES THE SPAWN rather than proceeding tool-less. The silent version of this cost a
	// green suite to notice; a run whose agent quietly lost its tools would report as a behaviour finding
	// about the agent, which is the most expensive wrong answer this surface can give.
	const defs = await Door.pull( 'mcp_store', 'tools' );
	if ( !isOk( defs ) ) return { refusal: refuse( defs, `${ tool } ( binding tool defs )` ) };
	agent.bindEnv( { toolDefs: ( ( defs.value ?? [] ) as { tools: ToolDef[] }[] ).flatMap( ( s ) => s.tools ?? [] ) } );

	return { agent };
}

/** The part of a `models.roster` row that answers "what serves this model". The row carries the Models
 *  panel's whole join — its doc, its config, its visibility — and none of that is this question. */
interface ModelRow {
	key:      string;
	label:    string;
	provider: string;
	modelId:  string;
	family?:  { key: string; label: string };
	status?:  unknown;
}

/** How much of a system prompt `describe_agent` quotes. Enough to recognise it by; the rest is a count. */
const PROMPT_PREVIEW = 200;

/**
 * Resolve an agent's model KEY against the roster the picker reads.
 *
 * THREE ANSWERS, KEPT APART. `null` is an agent that never dispatches — the vault case, where naming a model
 * would be a lie. A key the roster does not hold is `unresolved`, stated rather than guessed, because a turn
 * on that agent fails `unknown_model` before anything is sent and a reader deciding whether to spawn needs to
 * know that first. Everything else comes back with its provider, which is what says Claude or local.
 */
async function describeModel( key: string | null, tool: string ): Promise<{ value: unknown } | { refusal: ToolResult }> {
	if ( key === null ) return { value: null };
	const reply = await Door.pull( 'models', 'roster' );
	if ( !isOk( reply ) ) return { refusal: refuse( reply, `${ tool } ( model roster )` ) };

	const row = ( ( reply.value ?? [] ) as ModelRow[] ).find( ( r ) => r.key === key );
	if ( !row ) {
		return { value: { key, unresolved: 'No model with this key is in the roster. A turn on this agent fails `unknown_model` before anything is sent — the key is stale, or names a model not set up on this machine.' } };
	}
	return { value: { key, label: row.label, provider: row.provider, modelId: row.modelId, family: row.family?.label ?? null, status: row.status ?? null } };
}

/**
 * Emit the turn — the ONE place this file touches the wire, so the payload is built once.
 *
 * ── WHY `toolManifest` IS SENT EMPTY, WHICH IS NOT A SHORTCUT ───────────────────────────────────
 *
 * `chat_send` declares both `toolNames` and `toolManifest`, and only one of them is alive.
 *
 * `toolNames` is real and matters: CommunicationService feeds it to `_exposedTools`, which decides the
 * structured tool surface the turn actually carries. It comes from `suggestedToolNames()`, which reads
 * the agent's BOUND TOOL DEFS — so `resolveAgent` binds them off `mcp_store.tools` before the agent
 * gets here, the same way the renderer's store does. This file once claimed a rehydrated agent computed
 * the value correctly with nothing bound. That was true of an older implementation and stopped being
 * true without anything here changing; the suite caught it, which is the whole argument for the suite.
 *
 * `toolManifest` is DEAD ON THE WIRE. The Orchestrator states it outright: `input.toolManifest` is
 * deliberately not read any more, because the agent now builds the manifest from its own bound
 * `toolDefs` at turn open. The renderer still computes and ships a string that nothing consumes.
 *
 * THIS MATTERS BEYOND ONE FIELD, and it is why the reasoning is recorded rather than the value just
 * being passed. `toolDefs` is bound by `bindEnv` and is NOT part of the wire form, so `toolManifest()`
 * on a rehydrated agent would return an empty string anyway — and reproducing it properly would have
 * meant re-implementing the renderer's binder out here, which is precisely the second implementation
 * the thin-caller rule forbids. Had the field been live, this tool could not have been written this
 * way. It is dead, so the constraint never binds. Sending '' is therefore honest rather than lossy:
 * it is what the receiver ignores, and pretending to compute it would suggest a fidelity this side
 * does not have.
 *
 * ( The in-process version read the manifest off the canonical main-side Agent, which was subtly
 *   wrong in its own way: `toolDefs` is bound per turn by the Orchestrator, so a dev-spawned turn sent
 *   an empty manifest for an agent that had never run and a stale one for an agent that had. Nothing
 *   consumed it, so nothing broke — a dead field absorbing a real defect. )
 *
 * The two thinking dials take the composer's own defaults. A test that needs others wants them as
 * arguments; a field with one possible value is speculative until then.
 */
/**
 * How many turns a session holds RIGHT NOW. The baseline half of the completion signal.
 *
 * READ AT FIRE TIME, NEVER AT WAIT TIME, and that is the whole reason it is a separate function that
 * both spawning tools call before they emit. A caller who fires and then asks 'has it finished' is asking
 * a question whose answer depends on a number taken BEFORE the turn existed — take it afterwards and a
 * turn that completed in the gap is indistinguishable from one that never started.
 */
async function turnCount( sessionId: string, tool: string ): Promise<number | { refusal: ToolResult }> {
	const got = await verb( 'communication.turns', tool, sessionId );
	if ( 'refusal' in got ) return got;
	const turns = got.value as unknown[] | null;
	return turns ? turns.length : 0;
}

/** One session row off the pull lane. `turnStatus` is RUNTIME-ONLY — never persisted, because a crash
 *  mid-turn would otherwise bring a session back permanently `thinking` — but it does ride
 *  `serializeForWire`, so this is a second READ of an existing fact rather than a new one to invent. */
async function turnStatus( sessionId: string, tool: string ): Promise<string | null | { refusal: ToolResult }> {
	const reply = await Door.pull( 'session_store', 'get', { id: sessionId } );
	if ( !isOk( reply ) ) return { refusal: refuse( reply, tool ) };
	const row = reply.value as { turnStatus?: string } | null;
	return row ? ( row.turnStatus ?? 'idle' ) : null;
}

async function fire( agent: Agent, sessionId: string, text: string, tool: string ): Promise<{ traceId: string } | { refusal: ToolResult }> {
	const traceId = randomUUID();
	const reply   = await Door.emit( 'chat_send', {
		traceId,
		agentId:        agent.id,
		sessionId,
		text,
		// `preloadedToolIds` IS THE PRODUCT'S OWN DERIVATION, and this mirrors it rather than rebuilding one.
		// The two-axis model landed 2026-08-26: POLICY says whether a tool may be called, SURFACE says how much
		// of it rides in the prompt, and `suggestedToolNames` retired with the word `suggested` itself. The
		// renderer sends exactly this list on `chat_send`, so a dev-spawned turn and a real one carry the same
		// tool surface — which is the only reason a green result here says anything about the product.
		toolNames:      agent.preloadedToolIds(),
		toolManifest:   '',
		thinkingEffort: 'medium',
		thinkingMode:   'chain'
	} );
	if ( reply.outcome !== 'accepted' ) return { refusal: refuse( reply, tool ) };
	return { traceId };
}

export function hotTools(): ToolDefinition[] {
	return [

		{
			name:        'dev_status',
			annotations: { readOnlyHint: true },
			description: 'Is Starmind actually up — router port, whether the renderer dev server answers, and what each window currently holds. Call this first; it is the only tool whose success proves the app is running.',
			doc:
				'THE ORIENTATION CALL FOR THE HOT HALF, and its role grew when this server moved out of the app. ' +
				'It used to be the check to run after a restart. It is now the check to run BEFORE anything, ' +
				'because a standalone server answers whether or not Starmind exists — a reply from any other ' +
				'tool no longer proves the app came back, or was ever there.\n\n' +
				'`renderer.reachable` is a real fetch against the dev server rather than a socket probe, because ' +
				'a listening port and a document that loads are different facts. `packaged: true` means there is ' +
				'no dev server by design and the field is not a failure.\n\n' +
				'`windows` is each window\'s own account — its current url and whether it is still loading. Read ' +
				'it BESIDE `renderer`: the case worth catching is a window holding the right address having ' +
				'failed to load anything from it. Main and the renderer fail independently, and the half that ' +
				'reports on itself is the half that still works.\n\n' +
				'`router.port` is the port actually bound, not the one requested — a taken fixed port falls back ' +
				'to ephemeral on purpose, and that fallback is exactly what a person is diagnosing when they ' +
				'ask. `supervised` says whether a restart rebuilds the whole dev session or only relaunches main.\n\n' +
				'IF THIS REFUSES WITH `unauthorized`, THE APP IS ALMOST CERTAINLY FINE. That outcome means a ' +
				'shared secret has two copies that stopped agreeing, and it is the one setup dependency nothing ' +
				'in this workspace sets for you. `STARMIND_DEV_TOKEN` must hold the SAME value in two places: ' +
				'`starmind/.env`, which the app reads once at startup to bind the dev principal, and the ' +
				'environment that started the MCP client, which this server inherits when it is spawned. No ' +
				'script writes either one; a person sets both by hand, in different files, months apart.\n\n' +
				'TWO CONSEQUENCES WORTH KNOWING BEFORE YOU DEBUG THE WRONG THING. Editing `.env` does not take ' +
				'until the app RESTARTS. Editing the shell does not take until the MCP CLIENT restarts, and ' +
				'exporting it in a terminal after the client is running reaches nothing at all. So the symptom ' +
				'outlives the fix in both directions, which is what makes it read as a broken rig.\n\n' +
				'`freshness` ANSWERS THE QUESTION THIS RIG COULD NOT PREVIOUSLY ASK: is the app running the code ' +
				'on disk. Every other field here says the app is ALIVE; none of them said it was CURRENT, and a ' +
				'result believed because the app answered is not the same as a result believed because the app is ' +
				'up to date. Four verdicts, and the two failures want opposite fixes:\n\n' +
				'  · `current` — the bundle is newer than every main source file, and this process is newer than ' +
				'the bundle.\n' +
				'  · `build-stale` — SOURCE IS NEWER THAN THE BUNDLE. The watcher has not caught up or is wedged. ' +
				'A restart alone will not help; it would relaunch into the same old code.\n' +
				'  · `process-stale` — the bundle was rebuilt AFTER this process started, so the code answering ' +
				'you predates the build. Every signal reads healthy. Restart.\n' +
				'  · `unknown` — a packaged build, or no dev bundle on disk. Freshness is not a question that has ' +
				'an answer there, and it says so rather than guessing `current`.\n\n' +
				'ONLY `src/main` AND `src/shared` COUNT. The renderer hot-reloads, so a renderer edit does not ' +
				'make a running main stale — including it would cry wolf on every component change. Note the ' +
				'instrument is mtimes, so touching a file without changing it reads as newer: it errs toward ' +
				'warning about a build that is fine over staying quiet about one that is not.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler:     async () => {
				const reply = await Door.status();
				if ( !isOk( reply ) ) return refuse( reply, 'dev_status' );

				const status = reply.value as Record<string, unknown>;

				// A MISSING `freshness` BLOCK IS ITSELF A FRESHNESS ANSWER, and the sharpest one available.
				// The check lives in the app, so an app too old to carry it cannot report on itself — the
				// absence says the running process predates the check, which means it predates at least one
				// edit. Reporting that as "unknown" would be true and useless; reporting nothing at all would
				// let the oldest possible app look like the quietest one.
				if ( status[ 'freshness' ] === undefined ) {
					status[ 'freshness' ] = {
						verdict: 'process-stale',
						why:     'this app is running code from BEFORE the freshness check existed, which it '
							+ 'proves by not carrying one. That is itself an out-of-date process. Restart the '
							+ 'dev session; if the check is still missing afterwards, the main bundle did not '
							+ 'rebuild and the watcher is wedged.'
					};
				}
				return ok( { reachedApp: true, door: Door.url, ...status } );
			}
		},

		{
			name:        'list_verbs',
			annotations: { readOnlyHint: true },
			description: 'Enumerate what the door can reach: bus channels currently SERVED, IPC commands DECLARED, and the pull lane with its reads and writes. Three lists, deliberately not merged.',
			doc:
				'WHAT THE APP\'S INTERNAL API SURFACE ACTUALLY IS, which nothing else states in one place. An ' +
				'agent cannot call a verb it cannot name, and the eleven verbs this surface depends on were ' +
				'originally found by grepping a source file — which neither scales nor survives a rename.\n\n' +
				'`served` now carries each channel WITH THE OPS IT DECLARES. `ops: null` is not an empty list — it ' +
				'means that channel routes a parametric op space and cannot name them, which is a different ' +
				'fact from accepting nothing. The list is PARTIAL by construction and says so rather than ' +
				'claiming a completeness it does not have.\n\n' +
				'TWO LISTS BECAUSE THE DELTA IS THE FINDING. `served` is read off the live dispatch map, so a ' +
				'service that failed to arm is absent rather than assumed. `commands` is read off the declared ' +
				'vocabulary, which is a static fact about the source. A channel that something CALLS and nothing ' +
				'SERVES is exactly the wiring bug that once let a tool go green against a channel which did not ' +
				'exist; merging the lists would hide it.\n\n' +
				'Both are read from the app\'s OWN registries. This server keeps no mirror of them — a dev ' +
				'surface holding its own list is a dev surface that is quietly wrong about the app three weeks ' +
				'later, and registering a path the ordinary way is meant to be the only registration anyone ' +
				'performs.\n\n' +
				'`pulls` is the THIRD list and the one that matters most for coverage: it is where every service ' +
				'serving no bus channel lives. `armed: false` means declared but not serving in this run, which is a ' +
				'different fact from not being declared at all. `reads` are callable through `read_state` and `writes` ' +
				'through `write_state`; both are listed because the SPLIT is the finding — which lane an op sits on ' +
				'decides which tool reaches it, and the two halves are not the same size.\n\n' +
				'NO SCHEMAS. A command is listed by name, lane and description; its full JSON Schema is ' +
				'`describe_surface { address: "emit:<name>" }`. This is the diagnostic view, and every command\'s ' +
				'schema in one reply was more than a client carries inline.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler:     async () => {
				const reply = await Door.verbs();
				if ( !isOk( reply ) ) return refuse( reply, 'list_verbs' );
				return ok( verbIndex( reply.value ) );
			}
		},

		{
			name:        'audit_bus_calls',
			annotations: { readOnlyHint: true },
			description: 'The other half of list_verbs: every bus verb the app SOURCE calls, judged against what the running app SERVES. Catches a verb that resolves undefined for a reason no caller can see.',
			doc:
				'THE DEFECT THIS CATCHES IS INVISIBLE AT RUN TIME. `Bus.request` answers a verb nothing serves by ' +
				'warning and resolving `undefined` — and `undefined` is also what a verb that ran and returned ' +
				'nothing resolves to. There is no value a caller can inspect to tell those apart, which is ' +
				'exactly how a tool once went green against a channel that did not exist.\n\n' +
				'IT IS AN INTEGRATION CHECK, not a lint. `list_verbs` tells you what is served; a source scan ' +
				'tells you what is called; only asking BOTH at once catches the gap. The app answers because ' +
				'both halves live there — the live dispatch map, and the routing rule that nests a package ' +
				'channel one level deeper than a floor verb. This server keeps no copy of either.\n\n' +
				'OP-LEVEL, WHICH THE UNIT SUITE CANNOT REACH. `CalledVerbs.test.ts` runs the same audit offline ' +
				'against a roster built from `ServiceIds` and `Packages`, and there it can only judge CHANNELS ' +
				'— a service\'s verb map is not knowable without running it. Here it is, so a misspelled OP is ' +
				'caught too. Run this after a service is renamed, retired, or fails to arm.\n\n' +
				'TWO BLIND SPOTS, REPORTED RATHER THAN OMITTED. `dynamic` counts calls whose verb is a variable ' +
				'( the router\'s own proxy and useBus\'s forwarder — generic by design, unresolvable by any ' +
				'scan ). `opsUnchecked` counts verbs on a channel declaring `ops: null`, which routes a ' +
				'parametric op space and cannot name its ops. A zero fault count alongside a nonzero blind ' +
				'spot is a PARTIAL pass, and saying so is the point.\n\n' +
				'`scanned: null` means the app cannot see its own source — expected in a packaged build. That ' +
				'is UNCHECKED, not clean, and the reply says so in words.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler:     async () => {
				const reply = await Door.calls();
				if ( !isOk( reply ) ) return refuse( reply, 'audit_bus_calls' );
				return ok( reply.value );
			}
		},

		{
			name:        'read_state',
			annotations: { readOnlyHint: true },
			description: 'Read any declared pull-channel op — the lane that reaches the 14 services which serve no bus verb at all. Reads only.',
			doc:
				'THE OTHER HALF OF THE APP. `/dev/verb` reaches the bus, which 11 services serve. The remaining 14 ' +
				'declare no bus channel and are reachable only here — `kcd_store`, `project_store`, `harness`, ' +
				'`exec_store`, `constellation`, `debug_screenshot_store` and the rest. Call `list_verbs` for the ' +
				'declared channels and their ops.\n\n' +
				'NOTHING WAS ADDED TO ANY SERVICE FOR THIS. The pull registry and the gate that validates against ' +
				'it already existed for the renderer; this speaks the same envelope through the same entry point. A ' +
				'service becomes reachable by declaring a channel the ordinary way — there is no second table.\n\n' +
				'READS ONLY — A LANE, NOT A LIMIT. Every channel declares a reads/writes split; `write_state` serves ' +
				'the other half. This tool simply never asks for one, so a write op reached through it comes back ' +
				'`write-refused` instead of being performed. That is the point of the split: a tool whose NAME says it ' +
				'reads cannot mutate the app because someone mistyped an op.\n\n' +
				'FIVE OUTCOMES THAT LOOK ALIKE AND ARE NOT: `unregistered` ( not declared — a fact about the ' +
				'source ), `unarmed` ( declared, but nothing serving it in this run — a fact about this boot ), ' +
				'`sealed` ( declared, armed, and closed to this door on purpose — a fact about the RULES, and ' +
				'`cred_store` is the one that is ), `write-refused`, and a real value that happens to be null. The ' +
				'gate itself answers all of them with a bare null; they are separated before dispatch so they ' +
				'survive the trip.\n\n' +
				'SOME READS ON THIS LANE ARE ENORMOUS, AND THEY ARE ENORMOUS ON PURPOSE. These channels answer the ' +
				'RENDERER, which receives a reply into a process with memory and keeps only the columns it draws ' +
				'with. You receive it into a CONTEXT WINDOW, where it is spent before you can decline it. ' +
				'`models.roster` is the Models panel\'s entire join — every descriptor, the provider prose repeated ' +
				'once per row, the live config, and the one model bound to a root-context document inlines that ' +
				'whole document. Measured at roughly 15k tokens by a caller that wanted a list of model keys.\n\n' +
				'SO PASS `fields`. `read_state { channel: "models", op: "roster", fields: [ "key", "label", "tier", ' +
				'"status" ] }` answers that question for a rounding error. The projection happens HERE, after the ' +
				'door has answered: the channel is untouched and the renderer is unaffected.\n\n' +
				'A REPLY THAT NAMES NO FIELDS IS CAPPED AT ' + CEILING_TEXT + '. Over it, `value` is left out and `withheld` says ' +
				'so, beside `bytes` and `keys` — past it a client spills the reply to a file, and far past it closes the ' +
				'connection. Name the fields you need and the reply is transcribed as asked.\n\n' +
				'`bytes` AND `keys` RIDE ON EVERY REPLY, including an unprojected one. `bytes` is the size of the ' +
				'WHOLE value whatever you kept, and `keys` names every field that was on offer — so one wide call ' +
				'teaches you the narrow one. A field you name that no row serves comes back under `missing` rather ' +
				'than silently projecting to `{}`.',
			inputSchema: {
				type:       'object',
				properties: {
					channel: { type: 'string', description: 'The pull channel, e.g. "kcd_store" or "project_store".' },
					op:      { type: 'string', description: 'A declared READ op on that channel.' },
					args:    { type: 'object', description: 'Optional argument object, exactly as the renderer would send it.' },
					fields:  FIELDS_PARAM
				},
				required: [ 'channel', 'op' ]
			},
			handler: async ( args ) => {
				const channel = String( args[ 'channel' ] ?? '' );
				const op      = String( args[ 'op' ] ?? '' );
				if ( !channel || !op ) return fail( 'read_state needs a "channel" and an "op". Call list_verbs for the declared pull channels and their ops.' );

				const reply = await Door.pull( channel, op, args[ 'args' ] );
				if ( !isOk( reply ) ) return refuse( reply, 'read_state' );
				// `undefinedValue` rides back rather than being flattened: a channel that answered with nothing
				// and a channel that answered null are two facts, and this is the seam where they would collapse.
				// The projection is applied AFTER the door has answered and changes nothing about the call —
				// see `project` for why the narrowing belongs to the reader rather than to the channel.
				return ok( { channel, op, ...project( reply.value, args[ 'fields' ] ), undefinedValue: reply.undefinedValue } );
			}
		},

		{
			name:        'write_state',
			description: 'Perform any declared pull-channel WRITE — the ARRANGE half. Same lane and same gate as read_state; this one opts in to mutation.',
			doc:
				'THE ARRANGE HALF, and the half the rig lacked longest. `read_state` lets a run ASSERT; without this it ' +
				'could not SET UP, which leaves every check inheriting whatever state the app happened to be in. ' +
				'`Channels` declares 121 writes against 96 reads, so the mutating vocabulary is the LARGER half of the ' +
				'lane. Call `list_verbs` for the declared writes per channel.\n\n' +
				'THIS IS A REAL WRITE AGAINST A REAL APP. It goes through `PullGate.dispatch` — the same entry the ' +
				'renderer\'s IPC handler calls — so the gate plugs and the registry check run exactly as they do in ' +
				'life. There is no sandbox, no dry run and no undo. Project creation, vault saves and process control ' +
				'are all in reach. Read the op before calling it.\n\n' +
				'ONE CHANNEL IS SEALED AND CREDENTIALS ARE IT. `cred_store` is refused at the door in BOTH ' +
				'directions — reads, writes and metadata alike — and answers `sealed` for every op name on it. That ' +
				'is the door working rather than a fault to repair: a run needing a credential arranges its own ' +
				'instead of borrowing the user\'s.\n\n' +
				'NOT GOVERNED, AND KNOWINGLY SO. The pull lane stamps a `readonly` principal that NONE of its 25 ' +
				'handlers forward — for the renderer exactly as much as for this door — so nothing below here checks ' +
				'who is asking. What stands in for a gate is the TRACE: every call lands as `dev_door.write` on the ' +
				'capability channel, separate from the `dev_door.pull` a read leaves, so what a run CHANGED stays ' +
				'legible apart from what it merely looked at.\n\n' +
				'THE SAME OUTCOMES AS A READ: `unregistered` ( not declared — a fact about the source ), ' +
				'`unarmed` ( declared, but nothing serving it in this run — a fact about this boot ), `sealed` ' +
				'( declared, armed, and closed to this door on purpose — a fact about the RULES ), a thrown ' +
				'handler, and a real value. Passing a READ op here is allowed and does nothing surprising: the door ' +
				'cares that a write was ASKED FOR, not that one was required.\n\n' +
				'A WRITE CAN ANSWER WITH FAR MORE THAN YOU ASKED FOR, AND THAT IS NOT A BUG IN THE WRITE. ' +
				'`agent_store.create` returns the born agent WHOLE — its own service doc calls it "the one write ' +
				'that returns its product, because the caller needs the id" — because the composer that normally ' +
				'calls it hydrates that graph into a live Agent. The fat reply is load-bearing for the product and ' +
				'is not going to change. Measured at ~1MB / 2,900 lines by a caller that wanted one id.\n\n' +
				'SO PASS `fields`. `write_state { channel: "agent_store", op: "create", args: { … }, fields: [ "id", ' +
				'"name" ] }` performs exactly the same write and transcribes two strings. `bytes` still reports what ' +
				'the write actually returned, so you learn the cost without paying it twice. A product over ' + CEILING_TEXT + ' ' +
				'with no `fields` is withheld rather than transcribed — and the write has still happened.',
			inputSchema: {
				type:       'object',
				properties: {
					channel: { type: 'string', description: 'The pull channel, e.g. "project_store" or "kcd_store".' },
					op:      { type: 'string', description: 'A declared WRITE op on that channel.' },
					args:    { type: 'object', description: 'Optional argument object, exactly as the renderer would send it.' },
					fields:  FIELDS_PARAM
				},
				required: [ 'channel', 'op' ]
			},
			handler: async ( args ) => {
				const channel = String( args[ 'channel' ] ?? '' );
				const op      = String( args[ 'op' ] ?? '' );
				if ( !channel || !op ) return fail( 'write_state needs a "channel" and an "op". Call list_verbs for the declared pull channels and their writes.' );

				const reply = await Door.write( channel, op, args[ 'args' ] );
				if ( !isOk( reply ) ) return refuse( reply, 'write_state' );
				return ok( { channel, op, ...project( reply.value, args[ 'fields' ] ), undefinedValue: reply.undefinedValue } );
			}
		},

		{
			name:        'screenshot',
			annotations: { readOnlyHint: false, idempotentHint: true },
			description: 'Capture the app window headlessly and report whether the frame is blank. The only capture an automated caller can actually make — the interactive one waits on a human drag.',
			doc:
				'THE EYE ON THE WINDOW. An injected crossing can be accepted main-side and never reach the renderer, ' +
				'and no main-side signal distinguishes those two: `sequence` proves the command dispatched, this ' +
				'proves something happened on screen. Together they are a verifiable claim about the app rather ' +
				'than about its plumbing.\n\n' +
				'IT IS NOT THE `capture` OP. That one opens a drag-select overlay and parks on a person, so an ' +
				'automated caller waits forever — reachable, and not callable. This takes the whole window off its ' +
				'own webContents: no overlay, nothing else on the desktop can appear in the frame, and it works with ' +
				'the window behind another or on a second monitor.\n\n' +
				'THE VERDICT IS THE POINT, NOT THE FILE. `uniform` says the sampled frame was all one colour, which ' +
				'is the white-window signature — the failure where main answers every call normally while the ' +
				'renderer is dead. Assert on it. It reports UNIFORM rather than WHITE because that failure has ' +
				'presented white, black and theme-coloured, and it is sampled on a grid: `uniform: false` means a ' +
				'difference WAS found, `uniform: true` means none was found at the sampled points ( `sampled` says ' +
				'how many ). It is not a tool for comparing two shots.\n\n' +
				'ALWAYS READ `window` BEFORE BELIEVING A BLANK RESULT. A minimized or hidden window captures blank ' +
				'however healthy the app is, so `minimized` and `visible` ride the reply. Uniform + minimized is a ' +
				'fact about the window; uniform + visible is a fact about the renderer, and only the second is a bug.\n\n' +
				'`name` NAMES THE FILE AND OVERWRITES IT. Shots are regenerable churn in an ignored directory, so ' +
				'nothing accumulates by default — pass different names to keep several from one run. The reply ' +
				'carries the PATH, not the image: read the file to look at it.\n\n' +
				'THREE NON-CAPTURES, each a different fact: `busy` ( an interactive capture is open and its overlay ' +
				'would be photographed instead ), `no-window` ( the app is up and holds no window — a real finding, ' +
				'main can outlive its renderer ), `empty-frame` ( the window yielded nothing, usual for a minimized ' +
				'window and notable otherwise ).',
			inputSchema: {
				type:       'object',
				properties: {
					name: { type: 'string', description: 'Filename stem, no extension. Defaults to "latest". Overwrites any shot of the same name.' }
				},
				required: []
			},
			example: { name: 'after-chat-send' },
			handler: async ( args ) => {
				// THE WRITE LANE, and not because the door made us. This produces a file, and `write_state` is
				// where a tool that changes the disk belongs — a capture tool routed through the read lane would
				// be the exact trap that split those lanes: a name that says it looks, doing something.
				const reply = await Door.write( 'debug_screenshot_store', 'window', { name: args[ 'name' ] } );
				if ( !isOk( reply ) ) return refuse( reply, 'screenshot' );
				return ok( reply.value );
			}
		},

		{
			name:        'list_sessions',
			annotations: { readOnlyHint: true },
			description: 'List live sessions and the agents available to spawn. Read this before spawning if you do not already hold an agent id.',
			doc:
				'Returns `sessions` ( id, title, agent, status, turn count ) and `agents` ( id, name, model key, ' +
				'project ), which is everything the other tools need as input. `describe_agent` reads one agent whole, ' +
				'including which provider serves its model.\n\n' +
				'Live registry state, not history — a session that ended is not here.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler:     async () => {
				const gotSessions = await verb( 'session_store.list', 'list_sessions' );
				if ( 'refusal' in gotSessions ) return gotSessions.refusal;
				const gotAgents = await verb( 'agent_store.list', 'list_sessions' );
				if ( 'refusal' in gotAgents ) return gotAgents.refusal;

				const sessions = ( gotSessions.value ?? [] ) as SessionRef[];
				const agents   = ( gotAgents.value ?? [] ) as AgentSummary[];
				const byId     = new Map( agents.map( ( a ) => [ a.id, a.name ] ) );

				return ok( {
					sessions: sessions.map( ( s ) => ( {
						sessionId: s.id,
						title:     s.title ?? null,
						agentId:   s.agentId,
						agentName: byId.get( s.agentId ) ?? '( no live agent )',
						status:    s.status ?? 'unknown',
						// NULL WHEN THE ROW DID NOT CARRY ONE, never 0. `session_store.list` does not return a
						// count today, and reporting every session — including ones with real history — as
						// having no turns is a number a test branches on and is quietly wrong about. Null is
						// unmistakably "not answered here", and it sends a reader to `get_turns`, which asks
						// the authority that actually knows.
						turns:     s.turnCount ?? null
					} ) ),
					// THE SUMMARY ALREADY CARRIES THE MODEL. This used to keep `id` and `name` alone, which left a run
					// unable to tell a Claude agent from a local one while the app was answering the question.
					agents: agents.map( ( a ) => ( { id: a.id, name: a.name, model: a.model, projectId: a.projectId } ) )
				} );
			}
		},

		{
			name:        'describe_agent',
			annotations: { readOnlyHint: true },
			description: 'Read one agent whole — its model and the provider serving it, its lenses and habits ( including any the record names and could not load ), its system prompt, and the tools it is CONFIGURED with. For what one run would actually carry, see the doc.',
			doc:
				'The question to ask BEFORE spawning, and the one `list_sessions` only half answers. `agent` takes an id ' +
				'or name — the rule `spawn_agent` resolves by, so what this describes is what a spawn would run.\n\n' +
				'`model.provider` answers "is this Claude or a local model": `anthropic` and `claude_code_max` are Claude, ' +
				'`local` and `remote` are served endpoints, `test` is the scripted brain. A key the roster does not hold ' +
				'comes back `unresolved` rather than guessed, and `model: null` is an agent that never dispatches.\n\n' +
				'`tools.preloaded` is exactly the `toolNames` `spawn_agent` would send — computed the same way, off the ' +
				'same bound defs, which are the WHOLE served roster ( the renderer binds the same way ). It is the preload ' +
				'REQUEST, not the wire: the run\'s passport narrows it to what the run holds when the turn compiles, so it ' +
				'can name tools `tools.policies` does not grant. What one RUN actually carries is a per-session question — ' +
				'and THIS TOOL IS THE WRONG PLACE TO ASK IT. Read it with `read_state { channel: "capability", op: "now", ' +
				'args: { sessionId } }`, which composes the answer through the same doors a send uses — a compile reads ' +
				'its own roster from there rather than repeating it. The three answers differ ON PURPOSE and the gap ' +
				'between them is diagnostic: `policies` is what the agent DOCUMENT allows, `preloaded` is what a spawn ' +
				'would REQUEST, and `capability/now` is what this run would be HANDED if it sent now.\n\n' +
				'`lenses` and `habits` are what LOADED; `brokenLenses` and `brokenHabits` are what the record names and the ' +
				'host could not load, each with the reason. Both broken lists are always present, empty when nothing is lost, ' +
				'because a surface that omits them reads exactly like a surface that has none — and an agent quietly one lens ' +
				'short is the most expensive wrong answer this tool can give.\n\n' +
				'The system prompt is PREVIEWED, not transcribed: its length and its opening. `null` means none is set; ' +
				'zero characters is one deliberately left empty.',
			inputSchema: {
				type:       'object',
				properties: {
					agent: { type: 'string', description: 'Agent id, or its name — a near miss resolves when it matches one agent; an ambiguous name returns the candidates.' }
				},
				required: [ 'agent' ]
			},
			handler: async ( args ) => {
				const ref = String( args[ 'agent' ] ?? '' );
				if ( !ref ) return fail( 'describe_agent needs an "agent" — an agent id or name. Call list_sessions to see them.' );

				const resolved = await resolveAgent( ref, 'describe_agent' );
				if ( 'refusal' in resolved ) return resolved.refusal;
				const agent = resolved.agent;

				const model = await describeModel( agent.model, 'describe_agent' );
				if ( 'refusal' in model ) return model.refusal;

				const prompt = agent.systemPrompt;
				return ok( {
					id:           agent.id,
					name:         agent.name,
					projectId:    agent.projectId,
					model:        model.value,
					lenses:       agent.lenses.map( ( l ) => l.getPath() ).filter( Boolean ),
					// WHAT THE RECORD NAMES AND COULD NOT LOAD, beside what it did — always present, even empty.
					// `lenses` alone is a SUBSET of the authored stack that does not say it is one, so an agent
					// whose lens file moved described as an agent with fewer lenses, and this is the door a
					// harness reads instead of the screen. Empty and absent must not look alike here.
					brokenLenses: agent.brokenLenses.map( ( b ) => ( { name: b.name, position: b.position, reason: b.reason } ) ),
					habits:       agent.baseHabits,
					brokenHabits: agent.brokenHabits.map( ( b ) => ( { name: b.name, loaded: b.loaded, reason: b.reason } ) ),
					systemPrompt: prompt === null ? null : { chars: prompt.length, opening: prompt.slice( 0, PROMPT_PREVIEW ) },
					tools: {
						modes:     agent.toolModes,
						preloaded: agent.preloadedToolIds()
					}
				} );
			}
		},

		{
			name:        'spawn_agent',
			description: 'Create a real Starmind session on an existing agent and send it a first turn. Returns immediately with the session id — the turn runs in the background.',
			doc:
				'Starts a REAL session, not a simulation: the same sequence the composer performs when a person ' +
				'presses Send, so what it exercises is what ships.\n\n' +
				'`agent` accepts an agent id or its name; an ambiguous name is refused with the candidates. `prompt` is the first turn.\n\n' +
				'FIRE AND FORGET, WITH A WAY TO WAIT. The call returns as soon as the turn is accepted, carrying ' +
				'`sessionId`, `traceId` and `turnsBefore`. A turn takes 30-90 seconds, so blocking here would spend the ' +
				'tool budget asleep — but the run still has to know when it finished. Hand `sessionId` and `turnsBefore` ' +
				'to `wait_for_turn`; that pair is what makes the wait exact rather than a guess.\n\n' +
				'`turnsBefore` is 0 here by construction — the session was created a moment ago and nothing has spoken ' +
				'in it. It rides anyway so both spawning tools answer in one shape.\n\n' +
				'The `traceId` is how a call\'s own lines are found among several agents running at once, and ' +
				'`get_turns` is what to read once the wait returns.\n\n' +
				'THREE ROUND TRIPS, and deliberately not folded into one app-side helper: resolve the agent, ' +
				'create the session, fire the turn — the same three steps the composer takes, each through the ' +
				'verb the product already uses. Batching them would put a second implementation of the composer ' +
				'inside the rig meant to test it.\n\n' +
				'Use `list_sessions` first if you do not know which agents exist.\n\n' +
				'CHOOSE A SUBJECT BUILT FOR THIS, AND CHECK BEFORE YOU SPAWN. An agent whose tools sit at `ask` ' +
				'will stop mid-run on a question posed to a person who is not there, and the turn reports that as ' +
				'a TOOL TIMEOUT rather than as a pending approval. Nothing in this rig can answer it — that is a ' +
				'security ruling, not a gap ( see `list_decisions` ). Read the subject with `get_policies` first ' +
				'and pick one whose tools are granted `allow` on purpose. Building the subject correctly is the ' +
				'only thing that makes a run unattended.',
			inputSchema: {
				type:       'object',
				properties: {
					agent:  { type: 'string', description: 'Agent id, or its name — a near miss resolves when it matches one agent; an ambiguous name returns the candidates.' },
					prompt: { type: 'string', description: 'The first turn to send.' }
				},
				required: [ 'agent', 'prompt' ]
			},
			handler: async ( args ) => {
				const ref    = String( args[ 'agent' ] ?? '' );
				const prompt = String( args[ 'prompt' ] ?? '' );
				if ( !ref )    return fail( 'spawn_agent needs an "agent" — an agent id or name. Call list_sessions to see them.' );
				if ( !prompt ) return fail( 'spawn_agent needs a "prompt" — the first turn to send.' );

				const resolved = await resolveAgent( ref, 'spawn_agent' );
				if ( 'refusal' in resolved ) return resolved.refusal;
				const agent = resolved.agent;

				// `create` returns the row, so the id comes from the authority rather than being minted here
				// and hoped about. POSITIONAL, like every bus verb — the object form is the renderer's pull
				// channel, a different door onto the same method.
				const made = await verb( 'session_store.create', 'spawn_agent', agent.id, `dev: ${ prompt.slice( 0, 40 ) }` );
				if ( 'refusal' in made ) return made.refusal;
				const session = made.value as SessionRef | null;
				if ( !session ) return fail( `spawn_agent: created no session for agent "${ agent.name }" — the session store refused it. The verb was reached and answered; this is a fact about the app, not the connection.` );

				// FILED UNDER `Harness Agents`, ALWAYS, and this is the one place that can guarantee it. A rig that
				// spawns real sessions into the same folder a person keeps their own work in makes every test run a
				// small act of vandalism on someone else's list — and the mess is invisible until it is large.
				// Best-effort on purpose: the session EXISTS and its turn is about to fire, so a failed filing is a
				// cosmetic loss and refusing here would throw away a live session over a folder name.
				const filed = await Door.write( 'session_store', 'set_folder', { id: session.id, folder: HARNESS_FOLDER } );
				
				const fired = await fire( agent, session.id, prompt, 'spawn_agent' );
				if ( 'refusal' in fired ) return fired.refusal;

				// `turnsBefore` IS THE BASELINE FOR `wait_for_turn`, and here it is 0 by construction rather than by
				// measurement: `session_store.create` has just returned this id, so nothing can have spoken in it yet.
				// Returned anyway so both spawning tools answer in one shape and a sequence never has to branch.
				return ok( { sessionId: session.id, traceId: fired.traceId, agentId: agent.id, agentName: agent.name, accepted: true, turnsBefore: 0, folder: isOk( filed ) ? HARNESS_FOLDER : `UNFILED ( ${ filed.outcome } ) — the session is live and sitting in the default list` } );
			}
		},

		{
			name:        'send_to_agent',
			description: 'Send another turn to a session that already exists. Returns immediately — the turn runs in the background.',
			doc:
				'The follow-up half of `spawn_agent`, and the same contract: accepted, not finished. It returns ' +
				'`turnsBefore` — the turn count read BEFORE the emit — which is what `wait_for_turn` needs as a ' +
				'baseline. Read afterwards it could already include this turn, and a wait would then sit out its whole ' +
				'timeout waiting for a second one.\n\n' +
				'The session must already exist ( `list_sessions` ). Its agent, project and grants are whatever ' +
				'that session already holds — this adds a turn and changes nothing else about it.\n\n' +
				'THE AGENT COMES OFF THE SESSION, never off the caller. A turn belongs to whichever agent the ' +
				'session was assigned; letting a caller name one would allow two turns in one conversation to ' +
				'run as different agents, which is a state the rest of the system has no way to represent.\n\n' +
				'IF THE TURN COMES BACK REPORTING TOOL TIMEOUTS, CALL `list_decisions` BEFORE BELIEVING THEM. A ' +
				'gate at `ask` parks the call on a person who is not there and the client eventually gives up, so ' +
				'"slow" and "waiting for an approval nobody will give" arrive as the same message. The run cannot ' +
				'be rescued from here — no tool in this rig answers a decision, by ruling — so the fix is to drive ' +
				'a subject whose tools were granted `allow` up front.',
			inputSchema: {
				type:       'object',
				properties: {
					sessionId: { type: 'string', description: 'The session to send to.' },
					message:   { type: 'string', description: 'The turn text.' }
				},
				required: [ 'sessionId', 'message' ]
			},
			handler: async ( args ) => {
				const sessionId = String( args[ 'sessionId' ] ?? '' );
				const message   = String( args[ 'message' ] ?? '' );
				if ( !sessionId ) return fail( 'send_to_agent needs a "sessionId". Call list_sessions to see them.' );
				if ( !message )   return fail( 'send_to_agent needs a "message".' );

				const got = await verb( 'session_store.get', 'send_to_agent', sessionId );
				if ( 'refusal' in got ) return got.refusal;
				const session = got.value as SessionRef | null;
				if ( !session ) return fail( `send_to_agent: no live session "${ sessionId }". The app answered — the session does not exist. Call list_sessions.` );

				const resolved = await resolveAgent( session.agentId, 'send_to_agent' );
				if ( 'refusal' in resolved ) return resolved.refusal;
				const agent = resolved.agent;

				// READ BEFORE THE EMIT, NOT AFTER, and this ordering is the whole contract. A count taken after the
				// turn is accepted can already include it, and a caller waiting for the count to EXCEED that number
				// would wait out its entire timeout for a turn that had already landed. One read, in the right place.
				const before = await turnCount( sessionId, 'send_to_agent' );
				if ( typeof before !== 'number' ) return before.refusal;
				
				const fired = await fire( agent, sessionId, message, 'send_to_agent' );
				if ( 'refusal' in fired ) return fired.refusal;

				return ok( { sessionId, traceId: fired.traceId, agentId: agent.id, agentName: agent.name, accepted: true, turnsBefore: before } );
			}
		},

		{
			name:        'get_turns',
			annotations: { readOnlyHint: true },
			description: 'Read the turns of one session — what was actually said, and what the agent actually did.',
			doc:
				'The other half of the fire-and-forget contract: `spawn_agent` returns the moment a turn is ' +
				'accepted, and this is how the outcome is read back once it has run.\n\n' +
				'Pairs with the traces rather than replacing them. This says what the CONVERSATION holds; ' +
				'`trace-capability.jsonl` says what crossed the gate. A capability claim wants both — a turn ' +
				'reporting a refusal in prose and a `gate.verdict` line agreeing with it are two independent ' +
				'witnesses.\n\n' +
				'READ `status` BEFORE BRANCHING ON `count`. A turn persists only when it COMPLETES, so a session ' +
				'whose first turn is still running answers `count: 0` — identical to a session that never had one. ' +
				'`status` is the session\'s live run-state, and is what separates "not finished yet" from ' +
				'"nothing there". Null means the live registry has no row, which is what an ENDED session looks like.\n\n' +
				'`status` HAS TWO VALUES AND YOU ARE ASKING ABOUT FOUR STATES. `thinking` means a turn is genuinely ' +
				'running. `idle` means THREE different things: no turn was ever sent, a turn was accepted and has ' +
				'not started yet, or a turn DIED at the door before it started. The app flips to `thinking` several ' +
				'awaits into the send — after the model-descriptor lookup and, on a local model, after waiting on ' +
				'the server — and every early failure path ( unknown agent, no model bound, model not ready, ' +
				'unknown session ) returns BEFORE that flip and persists no turn at all. So a dead turn and a queued ' +
				'one both read `idle` / `count: 0`, and neither is distinguishable from a session nobody touched. ' +
				'Filed as an app defect 2026-09-05; this tool cannot fix it from out here.\n\n' +
				'WHAT TO DO ABOUT IT TODAY. Use `wait_for_turn`, which exists for exactly this and separates a ' +
				'timeout at `thinking` ( SLOW ) from a timeout at `idle` with no new turn ( NEVER STARTED ). If you ' +
				'are polling by hand and a session has sat at `idle` / `count: 0` for longer than a send takes to be ' +
				'accepted, treat it as DEAD rather than slow: the failure was announced on the event lane, which is ' +
				'a lane this door does not listen to, so waiting longer will never turn it into an answer.\n\n' +
				'`terminal: failed` IS HALF AN ANSWER — READ `failure` BESIDE IT. It carries the reason that turn ' +
				'died, as one line, and it is empty on every turn that did not. A harness child that cannot ' +
				'authenticate, a model that refused, a dead socket and a bug in our own dispatch all read as ' +
				'`failed` and are told apart ONLY by this field. Do not diagnose a failed turn without it: an ' +
				'expired OAuth session was twice mistaken for a fault in Starmind because the terminal was all ' +
				'anyone looked at.\n\n' +
				'PASS `fields` IF YOU ONLY NEED THE SHAPE. A turn carries its full text, its thinking text and its ' +
				'entries; `fields: [ "terminal", "failure" ]` answers "did it finish, and if not why" without ' +
				'transcribing the conversation. `count` and `bytes` always describe the WHOLE session, whatever ' +
				'you kept.',
			inputSchema: {
				type:       'object',
				properties: {
					sessionId: { type: 'string', description: 'The session whose turns to read.' },
					fields:    FIELDS_PARAM
				},
				required: [ 'sessionId' ]
			},
			handler: async ( args ) => {
				const sessionId = String( args[ 'sessionId' ] ?? '' );
				if ( !sessionId ) return fail( 'get_turns needs a "sessionId". Call list_sessions to see them.' );

				// POSITIONAL. The `{ sessionId }` object form is the renderer's pull channel — a different door
				// onto the same loader — and passing it here would stringify to "[object Object]" and load nothing.
				const got = await verb( 'communication.turns', 'get_turns', sessionId );
				if ( 'refusal' in got ) return got.refusal;

				// ABSENCE IS NOT FAILURE, and the two must not share a value. A session with no turns yet is a
				// legitimate answer and comes back as an empty list; a session that does not exist is a
				// different fact and says so, because a caller reading one for the other either waits forever
				// for a turn that was never accepted or concludes a real session is empty.
				const turns = got.value as unknown[] | null;
				if ( !turns ) return fail( `get_turns: no turns for "${ sessionId }" — the session does not exist, or the conversation was never created. The app answered; this is not a connection problem. Call list_sessions.` );

				// RUN-STATE BESIDE THE COUNT, because `count: 0` alone is two facts wearing one value: a
				// session whose first turn is still running looks exactly like one that never had a turn.
				// A turn persists only on COMPLETION, so polling right after `spawn_agent` reads zero and a
				// caller cannot tell "not finished" from "nothing there" without going to the trace. The
				// authority already knows — `session_store.list` carries a status per session — so this is a
				// second read rather than a new fact. Null when the registry has no row for it: absence is
				// not failure, and a session that ended is not in the live registry at all.
				const listed = await verb( 'session_store.list', 'get_turns' );
				const rows   = ( 'refusal' in listed ? [] : ( listed.value ?? [] ) ) as { id: string; status?: string }[];
				const status = rows.find( ( r ) => r.id === sessionId )?.status ?? null;

				// `count` is the WHOLE count and `bytes` the whole size, whatever the projection kept — a
				// narrowed read must never make a session look shorter than it is.
				const shown = project( turns, args[ 'fields' ] );
				return ok( { sessionId, count: turns.length, status, bytes: shown.bytes, keys: shown.keys, missing: shown.missing, withheld: shown.withheld, turns: shown.value } );
			}
		},

		{
			name:        'wait_for_turn',
			annotations: { readOnlyHint: true },
			description: 'Block until a session finishes the turn it was given, or time out. The completion signal spawn_agent and send_to_agent deliberately do not carry.',
			doc:
				'THE OTHER HALF OF FIRE-AND-FORGET. `spawn_agent` and `send_to_agent` return the moment a turn is ' +
				'ACCEPTED, which is right — a turn takes 30-90 seconds and a tool that blocked on one would spend ' +
				'most of its budget asleep. But an unattended run then has nothing to wait ON, and the only ' +
				'closing move was polling a trace file at a guessed interval. This is that move, done once.\n\n' +
				'PASS `afterTurns` FROM THE SPAWN REPLY. Both spawning tools now return `turnsBefore`, read BEFORE ' +
				'they emit. Hand it back here and the wait is exact. Omit it and this takes its own baseline, ' +
				'which cannot see a turn that finished in the gap — the reply labels which baseline it used ' +
				'rather than reporting a confident wrong answer.\n\n' +
				'`turnStatus: idle` IS NOT A COMPLETION SIGNAL ON ITS OWN, and that is the trap this tool exists ' +
				'to avoid. A session sits at `idle` for the whole gap between accepting a turn and starting it, ' +
				'so a wait watching only the status would return SUCCESS instantly for a turn that had not begun. ' +
				'The condition is a CONJUNCTION: a new turn is present AND the session is back at idle.\n\n' +
				'TWO TIMEOUTS THAT MUST NOT COLLAPSE. Timing out while `thinking` means the turn is SLOW — raise ' +
				'the timeout or look at what the model is waiting on. Timing out at `idle` with no new turn means ' +
				'the turn NEVER STARTED, which is a different bug: a send that was not accepted, an orchestrator ' +
				'that did not arm, a session deleted underneath it. The reply says which, and whether `thinking` ' +
				'was ever observed at all.\n\n' +
				'`finished` MEANS OVER, NOT OK, and the difference is load-bearing. CommunicationService flips the ' +
				'session back to `idle` from a FINALLY, and a failed turn is persisted like any other ( with its ' +
				'normalized error and `include: 0` ), so a turn that threw satisfies this wait exactly as a successful ' +
				'one does. That is the right behaviour — a run must not hang because a turn failed — but it means a ' +
				'caller asserting SUCCESS has to read `get_turns` afterwards. This tool answers when, never whether.\n\n' +
				'IT POLLS, FROM OUT HERE, and that is a choice rather than a shortcut. The app holds no completion ' +
				'event a caller can subscribe to across the door, and a blocking op would make Starmind hold a ' +
				'socket open for ninety seconds on behalf of a client that may already be gone. Polling is two ' +
				'reads the renderer already makes, repeated — so a hung app costs a timeout, not a wedged request.',
			inputSchema: {
				type:       'object',
				properties: {
					sessionId:  { type: 'string', description: 'The session to wait on.' },
					afterTurns: { type: 'number', description: 'The `turnsBefore` from the spawn reply. Omit only if you did not fire the turn yourself.' },
					timeoutMs:  { type: 'number', description: 'Give up after this long. Default 170000, just under the usual client timeout.' }
				},
				required: [ 'sessionId' ]
			},
			handler: async ( args ) => {
				const sessionId = String( args[ 'sessionId' ] ?? '' );
				if ( !sessionId ) return fail( 'wait_for_turn needs a "sessionId". Call list_sessions to see them.' );

				const timeoutMs = Number( args[ 'timeoutMs' ] ?? DEFAULT_WAIT_MS );
				const given     = args[ 'afterTurns' ];
				
				// THE INTERVAL FOLLOWS THE DEADLINE rather than being one fixed number. A caller asking for a five
				// second wait is asking a different question from one asking for three minutes, and answering both at
				// one-second granularity gives the short wait a 20% error bar. Capped at POLL_MS so the long case
				// stays cheap, floored so a tiny timeout cannot spin.
				const pollMs = Math.max( 25, Math.min( POLL_MS, Math.floor( timeoutMs / 20 ) ) );

				// THE BASELINE, AND WHETHER IT IS TRUSTWORTHY. A caller-supplied number was read before the
				// turn was emitted and is exact. One taken HERE was read after, so a turn that already
				// finished is already counted and this wait would sit through its whole timeout waiting for a
				// second one. Inferred rather than refused — the honest answer is available, it just has to
				// be labelled, and the reply labels it.
				let baseline: number;
				if ( typeof given === 'number' ) {
					baseline = given;
				} else {
					const now = await turnCount( sessionId, 'wait_for_turn' );
					if ( typeof now !== 'number' ) return now.refusal;
					baseline = now;
				}

				const startedAt = Date.now();
				let sawThinking = false;
				let polls       = 0;

				for ( ;; ) {
					polls++;
					const status = await turnStatus( sessionId, 'wait_for_turn' );
					if ( status !== null && typeof status !== 'string' ) return status.refusal;

					// A SESSION THAT IS NOT THERE is a fact about the session, not a slow turn. Refused at
					// once rather than waited out: a caller that mistyped an id should learn it in a second
					// rather than in three minutes, and a session deleted mid-wait is worth hearing about now.
					if ( status === null ) {
						return fail( `wait_for_turn: session "${ sessionId }" does not exist. The app answered, so this is not a connection problem — it may have been deleted while the wait was running. Call list_sessions.` );
					}

					if ( status === 'thinking' ) sawThinking = true;

					// Only worth the second read when the session is at rest. While it is thinking the count
					// cannot satisfy the condition anyway, so asking would be one loopback round trip per
					// second for an answer that cannot change the outcome.
					if ( status === 'idle' ) {
						const count = await turnCount( sessionId, 'wait_for_turn' );
						if ( typeof count !== 'number' ) return count.refusal;
						if ( count > baseline ) {
							return ok( {
								sessionId,
								finished:  true,
								turns:     count,
								newTurns:  count - baseline,
								waitedMs:  Date.now() - startedAt,
								polls,
								sawThinking,
								baseline:  typeof given === 'number' ? 'given' : 'inferred'
							} );
						}
					}

					if ( Date.now() - startedAt >= timeoutMs ) {
						// THE TWO TIMEOUTS, KEPT APART. Which one happened decides where a reader looks next,
						// and a single "timed out" would send them to the model when the send never landed.
						const why = sawThinking
							? 'The turn STARTED and was still running when the clock ran out. It is slow, not lost — raise timeoutMs, or read the trace for what it is waiting on.'
							: 'The session never left `idle`, so THE TURN NEVER STARTED. This is not a slow model. Look for a send that was not accepted, an orchestrator that did not arm, or a baseline taken after the turn had already finished ( pass `afterTurns` from the spawn reply to rule that out ).';
						return fail( `wait_for_turn: timed out after ${ Date.now() - startedAt }ms on "${ sessionId }" ( ${ polls } polls, baseline ${ baseline } turns ).\n\n${ why }` );
					}

					await new Promise( ( go ) => setTimeout( go, pollMs ) );
				}
			}
		},
		{
			name:        'list_decisions',
			annotations: { readOnlyHint: true },
			description: 'List the decisions currently posed to a person and not yet settled — what is blocking, and who is asking.',
			doc:
				'THE INSTRUMENT FOR AN `ask` POLICY. A gate at `ask` suspends its call on a person\'s answer, so ' +
				'an unattended run of one does not fail — it hangs. This is how that state becomes visible ' +
				'instead of looking like a slow turn.\n\n' +
				'MEASURED 2026-09-04, AND THE DRIVEN AGENT IS TOLD THE WRONG THING. Four gated calls came back to ' +
				'it as `MCP server "sm_file" tool "glob" timed out after 10s`. Nothing timed out — each call was ' +
				'parked on a question posed to a human who was not there, and the client gave up waiting. ' +
				'"The tool is slow" and "a person never answered" arrive as ONE VALUE, and they are the two facts ' +
				'an unattended run most needs to separate: one is worth retrying and the other never will be. ' +
				'So when a driven turn reports tool timeouts, CALL THIS BEFORE BELIEVING THEM.\n\n' +
				'READ-ONLY ON PURPOSE, AND THAT IS A SECURITY RULING RATHER THAN AN UNBUILT FEATURE ' +
				'( Bryan, 2026-09-04 ). Nothing here settles a decision and nothing ever will: an agent answering ' +
				'an approval on a person\'s behalf is privilege escalation with extra steps. The concrete shape — ' +
				'an agent holding one passport is asked to drive other agents; while driving them it does not hold ' +
				'the permission being asked about; if it could click Allow it would grant itself exactly what it ' +
				'was not given. THE HALT IS THE CONTAINMENT WORKING. If this lists something the run needs a ' +
				'human, and that is the end of it.\n\n' +
				'WHAT THAT MEANS FOR YOU, AND IT IS THE PART TO ACT ON: `ask` POLICIES ARE FUNDAMENTALLY ' +
				'INCOMPATIBLE WITH AGENTIC DEVELOPMENT. Do not drive a test subject that will be asked questions. ' +
				'Build it so it will not be — its tools granted `allow` up front, deliberately, by a person who ' +
				'decided what that subject may do. A subject configured for a human at the keyboard is the wrong ' +
				'subject for an unattended run, and finding that out mid-run costs the whole run.\n\n' +
				'`set_policy` IS NOT THE ESCAPE HATCH. It writes what governs the NEXT call; a posed decision is a ' +
				'question already asked and still waiting, so setting a policy leaves it standing. Measured: two ' +
				'gates set to `allow` cleared none of five open decisions. Fix the subject before the run rather ' +
				'than the gate during it.\n\n' +
				'THE REAL FIX COMES FROM ELSEWHERE. Once a passport rides the AGENT itself and is inherited by its ' +
				'sessions, one properly-built test agent serves most runs and is configured once rather than per ' +
				'session. This tool stays read-only after that lands.\n\n' +
				'Each row carries `agentName` and `agentId` — WHO is asking, which is the key to read when ' +
				'several agents are running. `traceId` says WHICH TURN, and is answerable only by the in-process ' +
				'lane: a routed harness call reaches the gate over HTTP with no per-turn trace, so an empty one ' +
				'there is a fact about the lane rather than a missing value.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler: async () => {
				const got = await verb( 'decisions.list', 'list_decisions' );
				if ( 'refusal' in got ) return got.refusal;
				const open = ( got.value ?? [] ) as unknown[];
				// The count is stated rather than left to be derived, because ZERO is the answer this tool
				// exists to deliver clearly: "nothing is blocking" is what an unattended run needs to assert,
				// and a bare empty array is easy to read as a call that did not work.
				return ok( { open: open.length, decisions: open } );
			}
		},

		{
			name:        'get_policies',
			annotations: { readOnlyHint: true },
			description: 'Read every permission gate, what it permits FOR ONE RUN, its secure default, and which tools declare it. Includes the global master stop.',
			doc:
				'The deck\'s own snapshot, through the same expression the deck reads. Call it before AND after ' +
				'`set_policy` — an assertion that a policy CHANGED is worth more than one that it was set, ' +
				'because the second only proves the call returned.\n\n' +
				'`tools` names what each row actually governs ( `server · tool` ). An EMPTY list is information ' +
				'rather than a gap: the row is live and currently governs nothing declared — which is also what ' +
				'a row under-reports while a TRANSITIONAL matcher is doing its selecting.',
			inputSchema: {
				type:       'object',
				properties: {
					sessionId: { type: 'string', description: 'WHICH RUN to read. Omit for the secure defaults — what a run holding no remembered answers gets.' }
				},
				required: []
			},
			handler: async ( args ) => {
				const sessionId = String( args[ 'sessionId' ] ?? '' );
				const got = await verb( 'permissions.rows', 'get_policies', { sessionId: sessionId || null } );
				if ( 'refusal' in got ) return got.refusal;
				if ( !got.value ) return fail( 'get_policies: `permissions.rows` was reached and returned nothing. That is a wiring fault in the app, not a policy state and not a connection problem.' );
				return ok( got.value );
			}
		},

		{
			name:        'set_policy',
			description: 'Set one permission gate to allow / ask / off FOR ONE RUN, or engage the global master stop. Returns that run\'s resulting rows.',
			doc:
				'The write that makes the deck testable. A row sitting at its secure default cannot be exercised ' +
				'without either changing it or finding a person.\n\n' +
				'`gateId` is a registered row ( `get_policies` lists them ); `policy` is `allow`, `ask` or `off`.\n\n' +
				'DO NOT SET A ROW TO `ask` IN AN UNATTENDED RUN. The call it governs will suspend on a human ' +
				'answer that is not coming, and the turn hangs rather than failing — `list_decisions` is how ' +
				'that is DETECTED, not how it is prevented. `allow` and `off` are the two settled ends and are ' +
				'what an autonomous test should use.\n\n' +
				'Pass `stopAll` instead of a gate to engage or lift the master stop, which refuses every tool ' +
				'call regardless of any row and is the one refusal offering no way around itself.\n\n' +
				'RUN-SCOPED, AND THAT IS LOAD-BEARING. A remembered policy lives on the passport of the run that ' +
				'answered it, so setting a row for one session changes nothing for the others running beside it. ' +
				'Pass the `sessionId` of the run you are testing — a session that has not sent a turn yet holds ' +
				'no passport and cannot be stamped.\n\n' +
				'THE MASTER STOP IS THE EXCEPTION and takes no session: it is global by ruling, because a person ' +
				'hitting stop means everything, now.\n\n' +
				'THE OLD LOCKOUT IS GONE. When this surface was a tenant of the app it was itself matched by the ' +
				'`third_party_tools` row, so setting that row to `off` refused `set_policy` and `restart_app` ' +
				'together and the only capability that could lift it was the first thing it took away. This ' +
				'server sits outside the gate by ruling, so a policy write can no longer disable the instrument ' +
				'that performs it.',
			inputSchema: {
				type:       'object',
				properties: {
					sessionId: { type: 'string', description: 'WHICH RUN remembers this. Required unless using stopAll — a policy is stamped on the run that answered it, never globally.' },
					gateId:    { type: 'string', description: 'The gate to set — omit when using stopAll.' },
					policy:    { type: 'string', enum: [ 'allow', 'ask', 'off' ], description: 'The policy to write.' },
					stopAll:   { type: 'boolean', description: 'Engage ( true ) or lift ( false ) the master stop instead of setting a row.' }
				},
				required: []
			},
			handler: async ( args ) => {
				const sessionId = String( args[ 'sessionId' ] ?? '' );
				const gateId    = String( args[ 'gateId' ] ?? '' );
				const policy    = String( args[ 'policy' ] ?? '' );
				const stopAll   = args[ 'stopAll' ] as boolean | undefined;

				// THE SNAPSHOT RIDES BACK so that "it was set" and "it is now this" are one call and cannot
				// disagree. A test asserting on the return value is then asserting on the authority's own
				// state rather than on this tool's report of having asked.
				//
				// WHAT WAS ASKED LIVES UNDER `requested`, AND THE FIRST VERSION OF THIS DID NOT. It spread
				// the arguments flat beside the snapshot, and for `stopAll` the two collided on one key —
				// the requested value written first, the authority's value overwriting it. The reply then
				// answered "did it work?" with a field that silently meant something else, which is this
				// project's signature defect authored into the tool built to catch it. Caught by the first
				// test run of the ported suite, which is the argument for porting it before the deletion
				// rather than after.
				//
				// The rule is now structural rather than remembered: `requested` is what the caller asked
				// for, everything at the top level is the authority's own state, and no future field can
				// collide with a snapshot key by accident.
				const snapshot = async (): Promise<Record<string, unknown>> => {
					const got = await verb( 'permissions.rows', 'set_policy', { sessionId: sessionId || null } );
					return 'refusal' in got ? {} : ( got.value ?? {} ) as Record<string, unknown>;
				};

				// The master stop is a FIELD BESIDE the table, not a row in it, so it is a different call
				// rather than a policy value — folding it in would make lifting it destroy the state it has
				// to put back.
				if ( stopAll !== undefined ) {
					const got = await verb( 'permissions.stopAll', 'set_policy', { on: stopAll } );
					if ( 'refusal' in got ) return got.refusal;
					return ok( { requested: { stopAll }, ...await snapshot() } );
				}

				if ( !gateId ) return fail( 'set_policy needs a "gateId", or a "stopAll" boolean. Call get_policies for the registered rows.' );
				// A POLICY BELONGS TO A RUN. There is no scope meaning "loosen this for everybody" — that
				// scope was the leak this whole surface was rebuilt to close — so a write with no session has
				// nowhere to land and says so, rather than appearing to succeed against nothing.
				if ( !sessionId ) return fail( 'set_policy needs a "sessionId" — a policy is remembered on the RUN that answered it, not globally. Use spawn_agent or list_sessions to get one. ( "stopAll" is the exception: the master stop is global and takes no session. )' );
				if ( policy !== 'allow' && policy !== 'ask' && policy !== 'off' ) {
					return fail( `set_policy needs "policy" to be allow, ask or off — got "${ policy }".` );
				}

				const got = await verb( 'permissions.set', 'set_policy', { sessionId, id: gateId, policy } );
				if ( 'refusal' in got ) return got.refusal;
				// A FALSE HERE IS AN UNKNOWN GATE **OR** A RUN WITH NO PASSPORT, and the two are worth telling
				// apart in the message: a session that has never sent holds no document to stamp, which reads
				// identically to a typo unless the failure says so.
				if ( !got.value ) return fail( `set_policy: could not set "${ gateId }" on session "${ sessionId }" — either no such gate ( call get_policies ) or that run has not sent a turn yet, so it holds no passport to stamp. The app answered; this is not a connection problem.` );

				return ok( { requested: { gateId, policy, sessionId }, ...await snapshot() } );
			}
		},

		{
			name:        'call_tool',
			description: 'Call one tool directly and get the gate verdict. Stands in the default project unless `asProject` names another; `asSession` judges it against a named run instead. The governed lane.',
			doc:
				'THE ONLY GOVERNED LANE ON THIS SURFACE, and the only one that can call a tool at all. Every ' +
				'other tool here reaches a bus verb or a pull op, which is the whole application MINUS its tool ' +
				'population &mdash; every keystone, every MCP server. Before this, the only way to exercise one ' +
				'was to spawn an agent and ask it nicely: slow, non-deterministic, and it confounds "the tool is ' +
				'broken" with "the model did not call it". A glob defect took three agent turns and six minutes ' +
				'to isolate here; one direct call answers it.\n\n' +
				'IT CROSSES THE REAL GATE. The door routes through the same expression a tenant call takes &mdash; ' +
				'same truck, same `ToolGate.invoke`. A lane with its own dispatch would be a second road to the ' +
				'same capability, and a green test on it would prove the road nothing ships on.\n\n' +
				'`asSession` BORROWS THE PAPERS OF A RUN, AND NARROWS RATHER THAN WIDENS. Omitted, the call is judged ' +
				'against the dev principal, which holds `allow` on EVERY tool the app serves &mdash; it is the ' +
				'instrument that drives every surface. Naming a session judges the call against the reach of THAT ' +
				'run instead, which is the only way to assert that a live agent policy CONSTRAINS ' +
				'something rather than merely that this key is powerful.\n\n' +
				'UNBORROWED, THE CALL STANDS IN A PROJECT &mdash; `asProject` when named, else the app\'s default ' +
				'project. It keeps the every-tool row and takes that project\'s REACH and DENIALS, so the ' +
				'documentation tools have a vault and `sm_log` entries land in the project\'s action log. A project ' +
				'`deny` and the master stop still refuse it, and nothing it is asked is remembered. This is the road ' +
				'for OPERATING in the project; `asSession` is the road for testing a run. Name one or neither.\n\n' +
				'THE RUN MUST ALREADY HOLD A PASSPORT. One is issued when a session takes its first turn, or ' +
				'authored through the capability deck. This reads an existing document and will not mint one, ' +
				'deliberately: a harness that created the papers it is testing would widen the thing it is ' +
				'measuring. A run with none comes back `no-such-run` &mdash; spawn a turn on it first.\n\n' +
				'A REFUSAL IS A RESULT, NOT AN ERROR. Half of what this is for expects one, so a refused call ' +
				'returns normally carrying the words of the gate itself. `borrowedFrom` rides every reply so a report ' +
				'can never be ambiguous about which reach produced the outcome.\n\n' +
				'Tools are addressed by IDENTITY &mdash; `group.tool`, e.g. `sm_file.glob` &mdash; the same key a ' +
				'mode is filed under. A bare name is refused rather than guessed at: two servers really do serve ' +
				'a tool called `glob`. Read `mcp_store.tools` through read_state for what is actually served.',
			inputSchema: {
				type:       'object',
				properties: {
					tool:      { type: 'string', description: 'Tool identity, "group.tool" — e.g. "sm_file.glob".' },
					args:      { type: 'object', description: 'The arguments of the tool itself, exactly as an agent would send them.' },
					asSession: { type: 'string', description: 'Judge against the passport of THIS run instead of the dev principal. The run must already hold one.' },
					asProject: { type: 'string', description: 'Stand in THIS project instead of the default one. Not with asSession — a run already has a project.' }
				},
				required: [ 'tool' ]
			},
			handler: async ( args ) => {
				const tool = String( args[ 'tool' ] ?? '' );
				if ( !tool ) return fail( 'call_tool needs a `tool` identity, addressed as "group.tool".' );

				const reply = await Door.callTool(
					tool,
					( args[ 'args' ] ?? {} ) as Record<string, unknown>,
					args[ 'asSession' ] ? String( args[ 'asSession' ] ) : undefined,
					args[ 'asProject' ] ? String( args[ 'asProject' ] ) : undefined
				);
				if ( !isOk( reply ) ) return refuse( reply, `call_tool ( ${ tool } )` );
				return ok( reply.value );
			}
		},

		{
			name:        'restart_app',
			description: 'Relaunch Starmind. Refuses unless the app is under the dev:proxied supervisor, because an unsupervised restart leaves a white window. Returns immediately; call dev_status afterwards to confirm it came back.',
			doc:
				'WHY IT EXISTS: main-process code does not hot-reload, so every change to a service, a gate or a ' +
				'tool table is inert until the app restarts. Without this an autonomous run stops at its first ' +
				'edit and waits for a person, which is the loop this surface exists to break.\n\n' +
				'THIS TOOL GAINED THE MOST FROM MOVING OUT OF THE APP. It used to kill the server that was ' +
				'serving the call, so nothing could observe the outcome — the caller had to leave and come back. ' +
				'This server survives the app it restarts, so `restart_app` then `dev_status` is a sequence that ' +
				'can be written down and asserted on. THAT is the loop an unattended run needs: apply a ' +
				'main-process change, restart, CONFIRM it came back, continue. Do not skip the confirm — a reply ' +
				'here only means the quit was scheduled.\n\n' +
				'EVERYTHING IN MEMORY IS LOST, which is mostly the point: session policy overrides, the master ' +
				'stop and every open decision return to their secure defaults. Live sessions do not survive, so ' +
				're-spawn afterwards and never hold a session id across it.\n\n' +
				'THE RENDERER NEEDS A SUPERVISOR, AND THIS TOOL NOW CHECKS RATHER THAN WARNING. Under ' +
				'`npm run dev:proxied` the dev session is rebuilt whole and the window returns. Started any ' +
				'other way, a restart relaunches Electron directly — main comes back and answers, but quitting ' +
				'the app also ends the renderer dev server, so the window is WHITE afterwards and anything that ' +
				'has to be seen or clicked, a decision prompt above all, is unavailable until a person restarts ' +
				'the dev session by hand.\n\n' +
				'SO AN UNSUPERVISED RESTART IS REFUSED BY DEFAULT, and `unsupervised: true` opts into it — the ' +
				'same shape as `write_state`\'s opt-in to mutation, where the dangerous thing is spelled in the ' +
				'call rather than left to whoever remembered to read a doc first. The refusal comes back as a ' +
				'VALUE naming what would have happened. Knowing this hazard and doing nothing about it is what ' +
				'this tool used to do, and it cost the renderer repeatedly.\n\n' +
				'AN UNREADABLE STATUS DOES NOT BLOCK. If the pre-check cannot reach the app the restart is ' +
				'attempted anyway, because its own refusal is the more accurate one — an app that cannot be ' +
				'asked whether it is supervised is not thereby proven unsupervised.\n\n' +
				'Allow a few seconds before the first call afterwards — the endpoint arms early in boot, but not ' +
				'instantly.',
			inputSchema: {
				type:       'object',
				properties: {
					unsupervised: { type: 'boolean', description: 'Restart even when the app is NOT under the dev:proxied supervisor, accepting that the renderer comes back WHITE and nothing clickable is available afterwards. Default false.' }
				},
				required: []
			},
			handler: async ( args ) => {
				// ADVISORY ABOUT REACHABILITY, BINDING ABOUT SUPERVISION. Only a status that was actually READ
				// and actually says `supervised: false` refuses. Anything else — app down, door unreachable, a
				// build too old to report the field — falls through to the restart, whose own refusal describes
				// the real problem better than a guess made from out here could. An app that cannot be asked
				// whether it is supervised is not thereby proven unsupervised.
				if ( args[ 'unsupervised' ] !== true ) {
					const status = await Door.status();
					if ( isOk( status ) && ( status.value as Record<string, unknown> )[ 'supervised' ] === false ) {
						return ok( {
							restarted: false,
							refused:   'unsupervised',
							why:       'This app is NOT running under the dev:proxied supervisor. Restarting would bring main back '
							         + 'answering normally while the renderer dev server stayed dead — a WHITE WINDOW with every tool '
							         + 'reporting healthy, which is worse than a clean failure because the half that reports on itself '
							         + 'is the half that still works.',
							remedy:    'Restart the session by hand with `npm run dev:proxied`, or pass unsupervised: true to accept a '
							         + 'main-only restart deliberately.'
						} );
					}
				}

				const reply = await Door.restart();
				if ( !isOk( reply ) ) return refuse( reply, 'restart_app' );
				return ok( { ...( reply.value as Record<string, unknown> ), confirmWith: 'dev_status — a reply here means the quit was scheduled, nothing more.' } );
			}
		},

		// The four DRIVE verbs. Their own file, listed here so a reload picks them up.
		...driveTools(),

		// The taskboard test bed's down / up / report. Their own file, listed here so a reload picks them up.
		...testbedTools()

	];
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type SerializedAgent } from '@kcd/core';

import { hotTools } from '../tools/hot';
import { TestApp, agentRow } from './TestApp';

/** The app's `agent_store.resolve`, doubled: by id, or by name in any case. The fuzzy pass is the app's and is
 *  tested there; what is tested here is what the tool does with each answer. */
function resolveIn( rows: Record<string, unknown>[], ref: string ): unknown {
	const match = rows.find( ( r ) => r[ 'id' ] === ref || String( r[ 'name' ] ).toLowerCase() === ref.toLowerCase() );
	return match
		? { status: 'found', match: Agent.fromSerialized( match as unknown as SerializedAgent ).summarize() }
		: { status: 'none', message: `No agent matches "${ ref }".` };
}

/**
 * The hot tools, driven through the REAL Door over a REAL socket into a scripted app.
 *
 * ── WHERE THESE CAME FROM ───────────────────────────────────────────────────────────────────────
 *
 * Most are ports of `starmind/src/main/__tests__/Dev.test.ts`, which covered the in-process tool
 * table that Phase 4 deletes. Porting them BEFORE the deletion was the point: the behaviours they
 * pin — an empty session versus a missing one, a null turn count versus zero, a policy stamp landing
 * on one run and not another — are properties of the TOOLS, and the tools did not stop existing when
 * they changed process. Deleting the table without moving these would have quietly traded ten
 * behavioural tests for nothing and left `test_census` reporting this package as having no suite.
 *
 * Two of the originals did NOT come across, and their absence is a ruling rather than an oversight.
 * They asserted that every tool declares a permission gate and that ungoverned is stated as
 * `gates: {}` rather than reached by silence. Both were true of a tenant living inside Starmind's
 * gate. This server sits outside it by ruling, declares no gates at all, and a test asserting it
 * declares them would now be asserting the opposite of the design.
 */
describe( 'the hot tools', () => {

	const tools = Object.fromEntries( hotTools().map( ( t ) => [ t.name, t ] ) );
	let app: TestApp;

	/** Read a tool's reply as JSON. Refusals are prose by design, so this is only for successes. */
	async function json( name: string, args: Record<string, unknown> = {} ): Promise<Record<string, unknown>> {
		const r = await tools[ name ]!.handler( args );
		expect( r.isError, `${ name } refused: ${ r.content[ 0 ]?.text }` ).not.toBe( true );
		return JSON.parse( r.content[ 0 ]!.text! ) as Record<string, unknown>;
	}

	/** Read a tool's refusal text. Asserts it IS a refusal — a tool that succeeded where a test
	 *  expected a refusal must not slip through as an empty string. */
	async function refusal( name: string, args: Record<string, unknown> = {} ): Promise<string> {
		const r = await tools[ name ]!.handler( args );
		expect( r.isError, `${ name } unexpectedly succeeded` ).toBe( true );
		return r.content[ 0 ]!.text!;
	}

	/** The one agent the app holds. BOTH tools are ALLOWED to run; only `srv.grep` is PRELOADED. That split is
	 *  the point: the wire carries preloaded ids, so an agent holding two tools sends one — and a double that
	 *  could not express the difference would pass on a shape the app cannot produce. */
	const tester = agentRow( 'a1', 'Tester',
		{ 'srv.grep': 'allow', 'srv.write': 'allow' },
		{ 'srv.grep': 'preload', 'srv.write': 'manifest' } );

	beforeEach( async () => {
		app = await new TestApp()
			.command( 'chat_send' )
			// The roster is summaries, built by the SDK's own `summarize` so the double cannot drift from what main
			// sends; the agent itself comes whole through `get`.
			.verb( 'agent_store.list', () => [ Agent.fromSerialized( tester as unknown as SerializedAgent ).summarize() ] )
			// The app's resolver answers found / ambiguous / none; the double answers by id or name, any case.
			.verb( 'agent_store.resolve', ( ref ) => resolveIn( [ tester ], String( ref ) ) )
			.verb( 'agent_store.get', ( id ) => ( id === 'a1' ? tester : null ) )
			.verb( 'session_store.list', () => [ { id: 's1', agentId: 'a1', title: 'One', status: 'active' } ] )
			.verb( 'session_store.get', ( id ) => ( id === 's1' ? { id: 's1', agentId: 'a1' } : null ) )
			.verb( 'session_store.create', ( agentId ) => ( { id: 's-new', agentId } ) )
			.verb( 'communication.turns', ( id ) => ( id === 's1' ? [] : null ) )
			.verb( 'decisions.list', () => [] )
			.verb( 'permissions.rows', () => ( { rows: [ { id: 'read', policy: 'allow' } ], stopAll: false } ) )
			// The tool catalogue the renderer's agent store binds off, and the reason `spawn_agent` can compute a
			// tool surface at all out here.
			//
			// THE DEFS STAMP AN `id`, BECAUSE THE REAL SEAM DOES. A tool def that crossed the priced serve seam
			// carries the WIRE IDENTITY `server.tool`, and `_modeKey` reads `id ?? name` — so a mode map keyed by
			// BARE NAME matches a def with no id and matches nothing real. This fixture used to omit `id`, which
			// made it pass on a shape the application never produces and left it blind to the exact mismatch that
			// silently emptied every lens's tool surface in the product. A double that is easier to satisfy than
			// the real thing is not a double, it is a second implementation with a lower bar.
			.pull( 'session_store', { reads: [ 'get' ], writes: [ 'set_folder' ], fn: () => true } )
			.pull( 'mcp_store', { reads: [ 'tools' ], fn: () => [ { id: 'srv', tools: [
				{ id: 'srv.grep',  name: 'grep',  description: 'g', inputSchema: {}, server: { id: 'srv', name: 'Srv', doc: '' } },
				{ id: 'srv.write', name: 'write', description: 'w', inputSchema: {}, server: { id: 'srv', name: 'Srv', doc: '' } }
			] } ] } )
			.pull( 'kcd_store',     { reads: [ 'catalog', 'quiet' ], writes: [ 'save' ], fn: ( a ) => ( a ? { asked: a } : undefined ) } )
			.pull( 'project_store', { reads: [ 'list' ], writes: [ 'create' ], armed: false } )
			.pull( 'debug_screenshot_store', { reads: [], writes: [ 'capture', 'window' ], fn: ( a ) => (
				( a as { name?: string } )?.name === 'nowindow'
					? { captured: false, why: 'no-window', detail: 'main outlived its renderer' }
					: { captured: true, filePath: 'C:/v/_Claude/work/debug/AI/screenshots/latest.png', width: 1600, height: 900,
					    window: { visible: true, minimized: false }, uniform: false, color: '#101418', sampled: 400 } ) } )
			.pull( 'cred_store', { reads: [ 'get', 'token' ], writes: [ 'set' ], sealed: 'The dev door does not read credentials — the whole channel, metadata included. Refused ON PURPOSE.' } )
			.listen();
	} );

	afterEach( async () => { await app.stop(); } );

	// ── The distinctions that must not collapse ──────────────────────────────────────────────

	it( 'tells an empty session apart from one that does not exist', async () => {
		// A session with no turns yet is a legitimate answer and must come back as an empty list. A
		// session that does not exist is a DIFFERENT fact. A caller that reads one for the other either
		// waits forever for a turn that was never accepted, or concludes a real session is empty.
		const empty = await json( 'get_turns', { sessionId: 's1' } );
		expect( empty[ 'count' ] ).toBe( 0 );

		const missing = await refusal( 'get_turns', { sessionId: 'nope' } );
		expect( missing ).toContain( 'does not exist' );
		// And it must say the app ANSWERED, so the reader does not go looking for a connection problem.
		expect( missing ).not.toContain( 'NOTHING WAS TESTED' );
	} );

	it( 'reports an unanswered turn count as null, never as zero', async () => {
		// `session_store.list` does not return a count. Zero is a number a test branches on and is
		// quietly wrong about; null is unmistakably "not answered here" and sends a reader to get_turns.
		const body = await json( 'list_sessions' );
		const rows = body[ 'sessions' ] as { turns: number | null }[];
		expect( rows[ 0 ]!.turns ).toBeNull();
	} );

	it( 'states an empty decision queue as a count rather than only an empty list', async () => {
		// ZERO is the answer this tool exists to deliver clearly — "nothing is blocking" is what an
		// unattended run needs to assert, and a bare empty array reads like a call that did not work.
		const body = await json( 'list_decisions' );
		expect( body[ 'open' ] ).toBe( 0 );
		expect( body[ 'decisions' ] ).toEqual( [] );
	} );

	// ── Spawning: the sequence, not just the result ──────────────────────────────────────────

	it( 'walks the composer\'s own four steps, in order', async () => {
		const body = await json( 'spawn_agent', { agent: 'a1', prompt: 'go' } );
		expect( body[ 'sessionId' ] ).toBe( 's-new' );
		expect( body[ 'accepted' ] ).toBe( true );

		// THE ORDER IS THE CLAIM. "It called them" is weaker than "it called them in the sequence the
		// composer performs", and the whole justification for this surface is that it takes the same road.
		//
		// FOUR STEPS, NOT THREE — the tool-def bind used to be invisible here, because a rehydrated agent
		// once computed its suggested surface off the mode map alone. It reads the DEFS now, so the bind is a
		// real step on the road and is asserted as one rather than left to be rediscovered by a live run.
		expect( app.asked.map( ( a ) => a.verb ) ).toEqual( [ 'agent_store.resolve', 'agent_store.get', 'mcp_store.tools', 'session_store.create', 'session_store.set_folder', 'chat_send' ] );
		expect( app.asked[ 5 ]!.mode ).toBe( 'emit' );
		// The roster is only matched against; the graph is fetched for the ONE agent that matched.
		expect( app.asked[ 1 ] ).toMatchObject( { verb: 'agent_store.get', args: [ 'a1' ] } );
	} );

	it( 'returns the trace id the turn actually rides under', async () => {
		// A fire-and-forget call is only useful if its outcome can be found afterwards, and every
		// capability line the turn produces is keyed by this id.
		const body    = await json( 'spawn_agent', { agent: 'a1', prompt: 'go' } );
		const payload = app.asked.find( ( a ) => a.verb === 'chat_send' )!.args[ 0 ] as { traceId: string };
		expect( body[ 'traceId' ] ).toBe( payload.traceId );
		expect( String( body[ 'traceId' ] ) ).not.toHaveLength( 0 );
	} );

	it( 'runs the one agent the app resolves a name to, and refuses an ambiguous or unknown one with its reason', async () => {
		const byName = await json( 'spawn_agent', { agent: 'tester', prompt: 'go' } );
		expect( byName[ 'agentId' ] ).toBe( 'a1' );

		// Ambiguity is refused with the candidates rather than chosen for: a test that silently ran as the
		// wrong agent is the defect this entire surface exists to stop.
		app.verb( 'agent_store.resolve', () => ( { status: 'ambiguous', candidates: [], message: '"t" matches more than one agent: Tester ( a1 ), Tessa ( a2 ).' } ) );
		expect( await refusal( 'spawn_agent', { agent: 't', prompt: 'go' } ) ).toContain( 'matches more than one agent' );

		app.verb( 'agent_store.resolve', () => ( { status: 'none', message: 'No agent matches "nobody".' } ) );
		expect( await refusal( 'spawn_agent', { agent: 'nobody', prompt: 'go' } ) ).toContain( 'No agent matches "nobody"' );
		expect( app.asked.filter( ( a ) => a.verb === 'chat_send' ) ).toHaveLength( 1 );
	} );

	it( 'refuses a spawn whose agent left the registry between the roster read and the fetch', async () => {
		app.verb( 'agent_store.get', () => null );

		const text = await refusal( 'spawn_agent', { agent: 'a1', prompt: 'go' } );
		expect( text ).toContain( 'gone when fetched' );
		expect( app.asked.some( ( a ) => a.verb === 'chat_send' ) ).toBe( false );
	} );

	it( 'sends the tool names the agent injects, computed off the rehydrated agent', async () => {
		// THE HEART OF 3.a. `suggestedToolNames()` reads effectiveToolModes(), which rides the wire form
		// in full — so a rehydrated copy computes the same answer the composer does. If this ever breaks,
		// a dev-spawned turn silently runs with a different tool surface from a real one, which
		// invalidates every result taken through this surface.
		await json( 'spawn_agent', { agent: 'a1', prompt: 'go' } );
		const payload = app.asked.find( ( a ) => a.verb === 'chat_send' )!.args[ 0 ] as { toolNames: string[] };
		expect( payload.toolNames ).toEqual( [ 'srv.grep' ] );   // the IDENTITY, and the PRELOADED one only
	} );

	it( 'takes the agent off the SESSION when sending, never off the caller', async () => {
		// A turn belongs to whichever agent the session was assigned. Letting a caller name one would
		// allow two turns in one conversation to run as different agents — a state nothing downstream
		// can represent.
		const body = await json( 'send_to_agent', { sessionId: 's1', message: 'more' } );
		expect( body[ 'agentId' ] ).toBe( 'a1' );
		expect( app.asked.map( ( a ) => a.verb ) ).toEqual( [ 'session_store.get', 'agent_store.resolve', 'agent_store.get', 'mcp_store.tools', 'communication.turns', 'chat_send' ] );
	} );

	// ── Describing an agent ──────────────────────────────────────────────────────────────────

	const PROMPT = 'You are the tester. '.repeat( 20 );

	/** The tester again, on a real model key, with the roster the picker reads answering for it. The row
	 *  carries the panel's own fields too, because the real one does and the tool must leave them out. */
	function onModel(): void {
		const modeled = { ...tester, model: 'cc.sonnet', systemPrompt: PROMPT };
		app.verb( 'agent_store.list', () => [ Agent.fromSerialized( modeled as unknown as SerializedAgent ).summarize() ] )
			.verb( 'agent_store.resolve', ( ref ) => resolveIn( [ modeled ], String( ref ) ) )
			.verb( 'agent_store.get', ( id ) => ( id === 'a1' ? modeled : null ) )
			.pull( 'models', { reads: [ 'roster' ], fn: () => [
				{ key: 'cc.sonnet', label: 'Sonnet', provider: 'claude_code_max', modelId: 'claude-sonnet-5',
				  family: { key: 'cc', label: 'Claude ( subscription )' }, status: 'ready', doc: 'THE PANEL DOC', config: {}, visible: true }
			] } );
	}

	it( 'lists each agent with its model key and project — the summary carried them all along', async () => {
		onModel();
		const body = await json( 'list_sessions' );
		expect( body[ 'agents' ] ).toEqual( [ { id: 'a1', name: 'Tester', model: 'cc.sonnet', projectId: 'p1' } ] );
	} );

	it( 'describes an agent\'s model by the provider that serves it, and nothing of the panel\'s row', async () => {
		onModel();
		const body = await json( 'describe_agent', { agent: 'Tester' } );
		expect( body[ 'model' ] ).toEqual( {
			key: 'cc.sonnet', label: 'Sonnet', provider: 'claude_code_max', modelId: 'claude-sonnet-5', family: 'Claude ( subscription )', status: 'ready'
		} );
		expect( JSON.stringify( body ) ).not.toContain( 'THE PANEL DOC' );
	} );

	it( 'names a model key the roster does not hold, rather than guessing what it meant', async () => {
		onModel();
		app.pull( 'models', { reads: [ 'roster' ], fn: () => [] } );
		const model = ( await json( 'describe_agent', { agent: 'a1' } ) )[ 'model' ] as Record<string, unknown>;
		expect( model[ 'key' ] ).toBe( 'cc.sonnet' );
		expect( String( model[ 'unresolved' ] ) ).toContain( 'unknown_model' );
	} );

	it( 'reports an agent that never dispatches as a null model, without asking the roster', async () => {
		const body = await json( 'describe_agent', { agent: 'a1' } );
		expect( body[ 'model' ] ).toBeNull();
		expect( app.asked.some( ( a ) => a.verb === 'models.roster' ) ).toBe( false );
	} );

	it( 'carries the tool surface a spawn would send, and previews the prompt rather than transcribing it', async () => {
		onModel();
		const body  = await json( 'describe_agent', { agent: 'a1' } );
		const tools = body[ 'tools' ] as { preloaded: string[]; policies: Record<string, string> };
		// THE SAME ANSWER `spawn_agent` SENDS AS `toolNames` — computed off the same bound defs. The preload
		// REQUEST, which the passport narrows at compile; not the wire.
		expect( tools.preloaded ).toEqual( [ 'srv.grep' ] );
		expect( tools.policies ).toEqual( { 'srv.grep': 'allow', 'srv.write': 'allow' } );

		const prompt = body[ 'systemPrompt' ] as { chars: number; opening: string };
		expect( prompt.chars ).toBe( PROMPT.length );
		expect( prompt.opening ).toBe( PROMPT.slice( 0, 200 ) );
	} );

	it( 'refuses a name the app cannot resolve, by the same rule a spawn resolves by', async () => {
		const miss = await refusal( 'describe_agent', { agent: 'nobody' } );
		expect( miss ).toContain( 'No agent matches "nobody"' );
	} );

	// ── Policy writes ────────────────────────────────────────────────────────────────────────

	it( 'refuses an unknown gate, a bad policy value, and a run with no passport — each differently', async () => {
		app.verb( 'permissions.set', () => false );

		expect( await refusal( 'set_policy', { sessionId: 's1' } ) ).toContain( 'needs a "gateId"' );
		expect( await refusal( 'set_policy', { gateId: 'read', policy: 'allow' } ) ).toContain( 'needs a "sessionId"' );
		expect( await refusal( 'set_policy', { sessionId: 's1', gateId: 'read', policy: 'maybe' } ) ).toContain( 'allow, ask or off' );

		// A false from the authority is an unknown gate OR a run holding no passport, and the message
		// says both — a session that has never sent reads identically to a typo unless it does.
		const refused = await refusal( 'set_policy', { sessionId: 's1', gateId: 'read', policy: 'allow' } );
		expect( refused ).toContain( 'no such gate' );
		expect( refused ).toContain( 'has not sent a turn yet' );
	} );

	it( 'carries the resulting rows back, so "it was set" and "it is now this" cannot disagree', async () => {
		app.verb( 'permissions.set', () => true );
		const body = await json( 'set_policy', { sessionId: 's1', gateId: 'read', policy: 'off' } );
		expect( body[ 'requested' ] ).toEqual( { gateId: 'read', policy: 'off', sessionId: 's1' } );
		// The snapshot is read from the authority AFTER the write, so a test asserting on this is
		// asserting on the app's own state rather than on the tool's report of having asked.
		expect( app.asked.filter( ( a ) => a.verb === 'permissions.rows' ) ).toHaveLength( 1 );
		expect( body[ 'rows' ] ).toBeDefined();
	} );

	it( 'engages the master stop as its own call, not as a policy value', async () => {
		// The stop is a FIELD BESIDE the table, not a row in it. Folding it in would make lifting it
		// destroy the state it has to put back.
		app.verb( 'permissions.stopAll', () => true );
		const body = await json( 'set_policy', { stopAll: true } );
		expect( app.asked.some( ( a ) => a.verb === 'permissions.set' ) ).toBe( false );

		// WHAT WAS ASKED AND WHAT IS NOW TRUE ARE TWO FACTS AND TWO KEYS. The first version of this tool
		// spread them onto one, so the authority's snapshot silently overwrote the requested value and the
		// reply answered a question nobody asked. Asserting on both is what makes the disagreement
		// between them visible — which is the whole reason the snapshot rides back at all.
		expect( body[ 'requested' ] ).toEqual( { stopAll: true } );
		expect( body[ 'stopAll' ] ).toBe( false );          // the scripted app has not moved
	} );

	// ── The completion signal, and the three ways it lies if you build it carelessly ──────────

	/**
	 * A scripted turn lifecycle: a session that goes idle → thinking → idle and gains a turn.
	 *
	 * `after` is how many POLLS pass before each transition, which is what lets a test say "the turn had
	 * not started yet on the first look" — the exact window the naive implementation reports success in.
	 */
	function scriptTurn( app: TestApp, opts: { startsAfter: number; endsAfter: number; baseTurns?: number } ): void {
		let look  = 0;
		let turns = opts.baseTurns ?? 0;
		app.pull( 'session_store', { reads: [ 'get' ], writes: [], fn: () => {
			look++;
			if ( look > opts.endsAfter ) return { id: 'w1', agentId: 'a1', turnStatus: 'idle' };
			if ( look > opts.startsAfter ) return { id: 'w1', agentId: 'a1', turnStatus: 'thinking' };
			return { id: 'w1', agentId: 'a1', turnStatus: 'idle' };
		} } );
		app.verb( 'communication.turns', () => {
			// The turn lands with the LAST status flip, not before it — a count that grew while the
			// session still read `thinking` would let a wrong implementation pass by accident.
			return look > opts.endsAfter ? new Array( turns + 1 ).fill( { role: 'assistant' } ) : new Array( turns ).fill( { role: 'assistant' } );
		} );
	}

	it( 'does not report a turn finished before it has started', async () => {
		// THE DEFECT THIS TOOL EXISTS TO AVOID. A session sits at `idle` for the whole gap between
		// accepting a turn and starting it, so a wait watching only `turnStatus` returns SUCCESS
		// immediately — for a turn that has not begun. The condition is a CONJUNCTION, and this is the
		// test that fails if anyone ever relaxes it back to a single read.
		scriptTurn( app, { startsAfter: 2, endsAfter: 4 } );

		const body = await json( 'wait_for_turn', { sessionId: 'w1', afterTurns: 0, timeoutMs: 2_000 } );
		expect( body[ 'finished' ] ).toBe( true );
		expect( body[ 'sawThinking' ] ).toBe( true );   // it really did observe the run, not just the rest
		expect( body[ 'turns' ] ).toBe( 1 );
		expect( Number( body[ 'polls' ] ) ).toBeGreaterThan( 1 );
	} );

	it( 'tells a turn that never started apart from one that is merely slow', async () => {
		// TWO TIMEOUTS THAT MUST NOT COLLAPSE. Both are "no answer in time" and they send a reader to
		// completely different places — the model, or the send that never landed. A single "timed out"
		// would be the right answer to a question nobody asked.
		app.pull( 'session_store', { reads: [ 'get' ], writes: [], fn: () => ( { id: 'w1', agentId: 'a1', turnStatus: 'idle' } ) } );
		app.verb( 'communication.turns', () => [] );

		const never = await refusal( 'wait_for_turn', { sessionId: 'w1', afterTurns: 0, timeoutMs: 2_000 } );
		expect( never ).toContain( 'NEVER STARTED' );

		app.pull( 'session_store', { reads: [ 'get' ], writes: [], fn: () => ( { id: 'w1', agentId: 'a1', turnStatus: 'thinking' } ) } );
		const slow = await refusal( 'wait_for_turn', { sessionId: 'w1', afterTurns: 0, timeoutMs: 2_000 } );
		expect( slow ).toContain( 'still running' );
	} );

	it( 'refuses a missing session at once instead of waiting out the clock', async () => {
		// A session that is not there is a fact about the SESSION, not a slow turn. Waited out, a mistyped
		// id costs three minutes and then reports a timeout, which names the wrong problem.
		app.pull( 'session_store', { reads: [ 'get' ], writes: [], fn: () => null } );

		const started = Date.now();
		const gone    = await refusal( 'wait_for_turn', { sessionId: 'nope', timeoutMs: 60_000 } );
		expect( gone ).toContain( 'does not exist' );
		expect( Date.now() - started ).toBeLessThan( 5_000 );
	} );

	it( 'labels an inferred baseline, because one taken here cannot see a turn that already landed', async () => {
		// The failure this labelling exists for: a caller who fires, waits, and passes no baseline gets a
		// count that ALREADY includes the finished turn — so `count > baseline` never becomes true and the
		// wait sits out its whole timeout for a turn that is done. Recorded in the reply either way, so a
		// reader can tell an exact answer from a best-effort one rather than assuming.
		scriptTurn( app, { startsAfter: 1, endsAfter: 2 } );

		const given = await json( 'wait_for_turn', { sessionId: 'w1', afterTurns: 0, timeoutMs: 2_000 } );
		expect( given[ 'baseline' ] ).toBe( 'given' );

		scriptTurn( app, { startsAfter: 1, endsAfter: 2 } );
		const inferred = await json( 'wait_for_turn', { sessionId: 'w1', timeoutMs: 2_000 } );
		expect( inferred[ 'baseline' ] ).toBe( 'inferred' );
	} );

	it( 'reads the baseline BEFORE it emits, which is the whole contract with wait_for_turn', async () => {
		// ORDERING IS THE CLAIM. Read after the emit and the count can already include the turn just
		// fired; a caller waiting for the count to EXCEED that number then waits forever. Asserted on the
		// call ORDER rather than on the number, because the number is right by luck in a fast test.
		app.verb( 'communication.turns', () => [ { role: 'user' }, { role: 'assistant' } ] );

		const body = await json( 'send_to_agent', { sessionId: 's1', message: 'again' } );
		expect( body[ 'turnsBefore' ] ).toBe( 2 );

		const order = app.asked.map( ( a ) => a.verb );
		expect( order.indexOf( 'communication.turns' ) ).toBeLessThan( order.indexOf( 'chat_send' ) );
	} );

	// ── The pull lane: four answers that the gate itself gives as one ────────────────────────

	it( 'separates unregistered, unarmed, write-refused and a real null', async () => {
		// `PullGate.dispatch` answers ALL of these with a bare null — the same collapse `Bus.request`
		// had before `Bus.routes()`, one lane over. They are told apart BEFORE dispatch so they survive.
		expect( await refusal( 'read_state', { channel: 'kcd_store',     op: 'nope' } ) ).toContain( 'unregistered' );
		expect( await refusal( 'read_state', { channel: 'kcd_store',     op: 'save' } ) ).toContain( 'write-refused' );   // a LANE refusal
		expect( await refusal( 'read_state', { channel: 'project_store', op: 'list' } ) ).toContain( 'unarmed' );

		// And a read that legitimately has nothing to say is a SUCCESS carrying that fact, not a refusal.
		const nothing = await json( 'read_state', { channel: 'kcd_store', op: 'quiet' } );
		expect( nothing[ 'undefinedValue' ] ).toBe( true );
		expect( nothing[ 'value' ] ).toBeNull();
	} );

	// ── THE HEADLESS CAPTURE. Plan item 3.f, and 3.b's missing eye.
	//
	// `sequence` proves a command DISPATCHED main-side; nothing main-side distinguishes that from the
	// renderer having acted on it. This is the other half, and the reason the two items that read as
	// independent are one.
	it( 'captures through the WRITE lane, because it makes a file', async () => {
		// The op is a declared WRITE. Routed through the read lane this would come back `write-refused` —
		// which is exactly the trap the lanes exist to set: a tool whose name says it looks, writing.
		const out = await json( 'screenshot', { name: 'landing' } );

		expect( out[ 'captured' ] ).toBe( true );
		expect( out[ 'uniform' ] ).toBe( false );
		expect( app.asked.at( -1 ) ).toMatchObject( { verb: 'debug_screenshot_store.window', mode: 'pull' } );
	} );

	// A non-capture is a VALUE, not an error. "The app holds no window" is a finding about the app worth
	// reading, and folding it into a failure would make it indistinguishable from the door being down.
	it( 'reports a non-capture as a finding rather than a failure', async () => {
		const out = await json( 'screenshot', { name: 'nowindow' } );

		expect( out[ 'captured' ] ).toBe( false );
		expect( out[ 'why' ] ).toBe( 'no-window' );
	} );

	// ── THE SEALED CHANNEL. Plan item 3.h.
	//
	// A FIFTH ANSWER, and the only one that reports the system WORKING. Every other refusal on this lane
	// describes something wrong and invites a fix; a seal describes a boundary behaving exactly as designed.
	// That is why it is named rather than folded into `unregistered` — "refused on purpose" and "never
	// existed" reading alike is the one thing a capability boundary must never do — and why the wording is
	// pinned: under the generic "did not succeed", an agent restarts the app and re-checks the token,
	// chasing a fault that does not exist.
	it( 'names a seal as deliberate rather than as a failure to repair', async () => {
		const out = await refusal( 'read_state', { channel: 'cred_store', op: 'get' } );
		expect( out ).toContain( 'sealed' );
		expect( out ).toContain( 'REFUSED ON PURPOSE' );
		expect( out ).toContain( 'nothing to repair' );
	} );

	// The ordering, mirrored from the real door: a seal is a fact about the CHANNEL, settled before any
	// op-level question. Below the registration check, an invented op would answer `unregistered` while a
	// real one answered `sealed`, and the door would be confirming which ops exist on the channel it is
	// refusing to discuss.
	it( 'answers an invented op on a sealed channel identically', async () => {
		const real     = await refusal( 'read_state', { channel: 'cred_store', op: 'token' } );
		const invented = await refusal( 'read_state', { channel: 'cred_store', op: 'no_such_op' } );
		expect( real ).toContain( 'sealed' );
		expect( invented ).toContain( 'sealed' );
	} );

	// Opting in to writes reaches the LANE check, never the seal. The two questions are different and the
	// second is not answered by asking louder.
	it( 'stays sealed for a write even WITH allowWrites', async () => {
		expect( await refusal( 'write_state', { channel: 'cred_store', op: 'set', args: { key: 'k', value: 'v' } } ) ).toContain( 'sealed' );
	} );

	// ── AND NOTHING WAS FETCHED. The door refuses before dispatch, so no value is read, held, or rendered
	// into a reply that lands in an agent transcript. The probe is deliberately unpronounceable: a leak test
	// whose probe can occur in ordinary prose reports the prose, and the next person quietens it by
	// loosening the check.
	it( 'repeats no argument back in the refusal', async () => {
		const out = await refusal( 'read_state', { channel: 'cred_store', op: 'get', args: { key: 'ZZ-PROBE-KEY-4417' } } );
		expect( out ).not.toContain( 'ZZ-PROBE-KEY-4417' );
	} );

	it( 'serves a write through write_state and refuses the same op through read_state', async () => {
		// THE REFUSAL IS LANE-SHAPED, NOT CAPABILITY-SHAPED, and this is the test that says so out loud. It
		// was capability-shaped once and that was never a guarantee: `room_store` serves its writes on the
		// BUS, so the identical op was reachable through `/dev/verb` the whole time it was refused here.
		// What survives is the part that IS worth keeping — a tool whose name says it reads cannot mutate.
		expect( await refusal( 'read_state', { channel: 'kcd_store', op: 'save' } ) ).toContain( 'write-refused' );

		const wrote = await json( 'write_state', { channel: 'kcd_store', op: 'save', args: { path: 'a.html' } } );
		expect( wrote[ 'value' ] ).toEqual( { asked: { path: 'a.html' } } );
		expect( app.asked.at( -1 ) ).toMatchObject( { verb: 'kcd_store.save', mode: 'pull' } );
	} );

	it( 'reports a declared-but-unarmed channel as a fact about THIS RUN, not about the source', async () => {
		// The distinction that decides where someone looks next: `project_store` IS declared, so the
		// source is fine and the service did not arm. Reading that as "not declared" sends a person to
		// edit a registry that is already correct.
		const text = await refusal( 'read_state', { channel: 'project_store', op: 'list' } );
		expect( text ).toContain( 'unarmed' );
		expect( text ).not.toContain( 'unregistered' );
		expect( text ).toContain( 'the app answered' );
	} );

	it( 'passes the argument object through the lane unchanged', async () => {
		const body = await json( 'read_state', { channel: 'kcd_store', op: 'catalog', args: { path: 'x.html' } } );
		expect( body[ 'value' ] ).toEqual( { asked: { path: 'x.html' } } );
	} );

	// ── Projection: what the reader keeps, not what the channel sends ────────────────────────
	//
	// The defect these pin was reported by an AGENT driving this rig, 2026-09-05: `models.roster` cost
	// it ~15k tokens to learn a list of model keys, and `agent_store.create` answered a request for one
	// id with ~1MB. Both replies are RIGHT — the renderer draws every column of the first and hydrates
	// the second into a live Agent — so nothing about either channel changed. What changed is that the
	// door stopped transcribing a reply whole when its reader asked for a slice of it.
	//
	describe( 'list_verbs — the diagnostic index', () => {

		// bug-report-20. The whole surface arrived in one reply, every command's full JSON Schema inside it, and it
		// was past what a client carries inline — the reply spilled to a file the moment it was asked for. A schema is
		// an AUTHORING fact, and `describe_surface` already serves one by address; this is the diagnostic view.

		it( 'lists each command by name, lane and description, and carries no schema', async () => {
			const body = await json( 'list_verbs' );
			const commands = body[ 'commands' ] as Record<string, unknown>[];
			expect( commands.map( ( c ) => c[ 'name' ] ) ).toEqual( [ 'chat_send' ] );
			for ( const c of commands ) {
				expect( Object.keys( c ).sort() ).toEqual( [ 'desc', 'lane', 'name' ] );
			}
		} );

		it( 'says in the reply where the schemas went, so a short list cannot read as a complete one', async () => {
			const body = await json( 'list_verbs' );
			expect( String( body[ 'schemas' ] ) ).toContain( 'describe_surface' );
			expect( String( body[ 'schemas' ] ) ).toContain( 'emit:' );
		} );

		it( 'keeps served, declared and pulled as three answers — the delta between them is the finding', async () => {
			const body = await json( 'list_verbs' );
			const served = body[ 'served' ] as { channel: string; ops: string[] | null }[];
			const pulls  = body[ 'pulls' ] as { channel: string; armed: boolean; reads: string[]; writes: string[] }[];
			expect( served.find( ( e ) => e.channel === 'agent_store' )?.ops ).toEqual( [ 'list', 'resolve', 'get' ] );
			expect( pulls.find( ( e ) => e.channel === 'project_store' ) ).toMatchObject( { armed: false, reads: [ 'list' ], writes: [ 'create' ] } );
			expect( body[ 'shapes' ] ).toMatchObject( { shaped: 1 } );
		} );
	} );

	// The property under test throughout is that the CALL is identical either way. A projected read and
	// an unprojected one must reach the app the same, or this stops being the road the product ships.

	describe( 'the fields projection', () => {

		/** A row wide enough that dropping columns is visible, standing in for a roster entry. */
		function fatRow( key: string ): Record<string, unknown> {
			return { key, label: key.toUpperCase(), tier: 'remote', status: 'ready', doc: 'D'.repeat( 400 ), config: { a: 1 }, rootContextText: 'R'.repeat( 4_000 ) };
		}

		beforeEach( () => {
			app.pull( 'models', { reads: [ 'roster' ], writes: [ 'send' ], fn: () => [ fatRow( 'one' ), fatRow( 'two' ) ] } );
		} );

		it( 'keeps only the named fields and still reports the whole size', async () => {
			const body = await json( 'read_state', { channel: 'models', op: 'roster', fields: [ 'key', 'tier' ] } );

			expect( body[ 'value' ] ).toEqual( [ { key: 'one', tier: 'remote' }, { key: 'two', tier: 'remote' } ] );

			// `bytes` DESCRIBES THE UNPROJECTED VALUE. A size that shrank with the projection would tell a
			// caller its narrow read was cheap and teach it nothing about the wide one it avoided — the
			// number exists precisely to price the road not taken.
			expect( body[ 'bytes' ] ).toBeGreaterThan( 8_000 );
		} );

		it( 'names every field that was on offer, so one wide call teaches the narrow one', async () => {
			const wide = await json( 'read_state', { channel: 'models', op: 'roster' } );
			expect( wide[ 'keys' ] ).toContain( 'rootContextText' );
			expect( wide[ 'keys' ] ).toContain( 'key' );
			// Discoverability is NOT conditional on asking for it: an agent that did not know a read was
			// expensive finds out on the call it already made, not on a second one it has no reason to make.
			expect( wide[ 'bytes' ] ).toBeGreaterThan( 8_000 );
		} );

		it( 'reports a field nobody serves instead of projecting it to nothing', async () => {
			// THE COLLAPSE THIS AVOIDS is the same one the four pull outcomes were separated to avoid, one
			// layer up: a misspelling and an empty row must not arrive wearing one value. A caller reading
			// `{}` for `keyy` would conclude the roster holds nothing and go looking in the wrong service.
			const body = await json( 'read_state', { channel: 'models', op: 'roster', fields: [ 'key', 'keyy' ] } );
			expect( body[ 'missing' ] ).toEqual( [ 'keyy' ] );
			expect( body[ 'value' ] ).toEqual( [ { key: 'one' }, { key: 'two' } ] );
		} );

		it( 'leaves the call itself untouched — the app cannot tell a projected read from a wide one', async () => {
			await json( 'read_state', { channel: 'models', op: 'roster', fields: [ 'key' ] } );
			const narrow = app.asked.at( -1 );
			await json( 'read_state', { channel: 'models', op: 'roster' } );
			const wide = app.asked.at( -1 );

			expect( narrow ).toEqual( wide );
			expect( narrow ).toMatchObject( { verb: 'models.roster', mode: 'pull' } );
		} );

		it( 'withholds an unnarrowed reply over the ceiling, and still teaches the narrow call', async () => {
			// A reply that size closes the client's connection, which reads as a dead server rather than as a
			// question asked too wide. What comes back instead is everything needed to ask again narrowly.
			app.pull( 'models', { reads: [ 'roster' ], writes: [ 'send' ], fn: () => [ { key: 'huge', doc: 'D'.repeat( 300_000 ) } ] } );

			const wide = await json( 'read_state', { channel: 'models', op: 'roster' } );
			expect( wide[ 'value' ] ).toBeUndefined();
			expect( String( wide[ 'withheld' ] ) ).toContain( 'fields' );
			expect( wide[ 'bytes' ] ).toBeGreaterThan( 300_000 );
			expect( wide[ 'keys' ] ).toEqual( [ 'key', 'doc' ] );

			// Naming fields is the caller saying what it wants, and it is transcribed as asked.
			const narrow = await json( 'read_state', { channel: 'models', op: 'roster', fields: [ 'key' ] } );
			expect( narrow[ 'value' ] ).toEqual( [ { key: 'huge' } ] );
			expect( narrow[ 'withheld' ] ).toBeUndefined();
		} );

		it( 'transcribes an unnarrowed reply under the ceiling whole', async () => {
			const body = await json( 'read_state', { channel: 'models', op: 'roster' } );
			expect( body[ 'value' ] ).toHaveLength( 2 );
			expect( body[ 'withheld' ] ).toBeUndefined();
		} );

		it( 'withholds a reply the client would have spilled, well short of a connection-closing size', async () => {
			// bug-report-20. The ceiling sat at 256 KB, set against a client CLOSING the connection; the client stops
			// carrying a reply inline long before that, at roughly 90 KB, and spills it to a file. A reply this size
			// passed the old ceiling and failed at the client, which is the outcome the ceiling exists to prevent.
			app.pull( 'models', { reads: [ 'roster' ], writes: [ 'send' ], fn: () => [ { key: 'wide', doc: 'D'.repeat( 100_000 ) } ] } );

			const wide = await json( 'read_state', { channel: 'models', op: 'roster' } );
			expect( wide[ 'value' ] ).toBeUndefined();
			expect( String( wide[ 'withheld' ] ) ).toContain( 'fields' );
			expect( wide[ 'keys' ] ).toEqual( [ 'key', 'doc' ] );
		} );

		it( 'measures the ceiling on the reply as transcribed, not as compact JSON', async () => {
			// Small rows compact to far less than they transcribe: indentation nearly doubles a real reply. A ceiling
			// read off the compact form lets through a reply the client then refuses, so this list is under the
			// ceiling compacted and over it as the door writes it out.
			const rows = Array.from( { length: 3_000 }, ( _v, i ) => ( { a: i, b: 2 } ) );
			app.pull( 'models', { reads: [ 'roster' ], writes: [ 'send' ], fn: () => rows } );
			expect( JSON.stringify( rows ).length ).toBeLessThan( 60_000 );

			const wide = await json( 'read_state', { channel: 'models', op: 'roster' } );
			expect( wide[ 'value' ] ).toBeUndefined();
			expect( wide[ 'bytes' ] ).toBeGreaterThan( 60_000 );
		} );

		it( 'withholds a WRITE product over the ceiling without undoing the write', async () => {
			app.pull( 'agent_store', { reads: [], writes: [ 'create' ], fn: () => ( { id: 'a-new', lenses: [ { body: 'L'.repeat( 300_000 ) } ] } ) } );

			const body = await json( 'write_state', { channel: 'agent_store', op: 'create', args: { name: 'Born' } } );
			expect( body[ 'value' ] ).toBeUndefined();
			expect( String( body[ 'withheld' ] ) ).toContain( 'ceiling' );
			expect( app.asked.at( -1 ) ).toMatchObject( { verb: 'agent_store.create', mode: 'pull' } );
		} );

		it( 'projects a WRITE product without narrowing the write', async () => {
			// `agent_store.create` is the live case: it answers with the whole born agent because the
			// composer needs to hydrate it. A rig that wanted the id had to eat the graph to read one field.
			app.pull( 'agent_store', { reads: [], writes: [ 'create' ], fn: () => ( { id: 'a-new', name: 'Born', lenses: [ { body: 'L'.repeat( 5_000 ) } ] } ) } );

			const body = await json( 'write_state', { channel: 'agent_store', op: 'create', args: { name: 'Born' }, fields: [ 'id', 'name' ] } );
			expect( body[ 'value' ] ).toEqual( { id: 'a-new', name: 'Born' } );
			expect( body[ 'bytes' ] ).toBeGreaterThan( 5_000 );
			// The WRITE ran in full, with the arguments it was given. Projection is transcription, never scope.
			expect( app.asked.at( -1 ) ).toMatchObject( { verb: 'agent_store.create', mode: 'pull' } );
		} );

		it( 'keeps get_turns honest about the count while narrowing what it prints', async () => {
			app.verb( 'communication.turns', () => [
				{ role: 'user',      text: 'U'.repeat( 3_000 ), terminal: null },
				{ role: 'assistant', text: 'A'.repeat( 3_000 ), terminal: 'end_turn' }
			] );

			const body = await json( 'get_turns', { sessionId: 's1', fields: [ 'role', 'terminal' ] } );

			// COUNT IS THE WHOLE COUNT. A projection that made a session look shorter than it is would break
			// the one contract every polling caller depends on, which is the reason to read this tool at all.
			expect( body[ 'count' ] ).toBe( 2 );
			expect( body[ 'turns' ] ).toEqual( [ { role: 'user', terminal: null }, { role: 'assistant', terminal: 'end_turn' } ] );
			expect( body[ 'bytes' ] ).toBeGreaterThan( 6_000 );
		} );

	} );

	// ── audit_bus_calls ──────────────────────────────────────────────────────────────────────
	//
	// THE APP DOES THE AUDIT, so what these test is the CARRY. Both halves of the comparison live over
	// there — the live dispatch map, and the routing rule that nests a package channel a level deeper
	// than a floor verb — and a copy of either in this package would be a check that silently stops
	// covering package verbs the day the layout moves. What can go wrong on this side is a reply that
	// arrives intact and is reported as something simpler than it is.

	it( 'carries the blind-spot counts, so a zero fault count cannot read as full coverage', async () => {
		// THE FAILURE THIS FORBIDS is a tool that prints "0 faults" over a reply saying three call sites
		// were unresolvable and forty ops were unjudged. That is a PARTIAL pass, and collapsing it into a
		// clean one is the same advertise-versus-reality defect the audit exists to find, committed by
		// the thing reporting it.
		await app.stop();
		const scripted = await new TestApp().callsAudit( {
			scanned:      { roots: [ 'src/main' ], sites: 103, verbs: 63 },
			faults:       [],
			dynamic:      [ { file: 'F.ts', line: 9 } ],
			opsUnchecked: 40
		} ).listen();
		try {
			const out = await json( 'audit_bus_calls' );
			expect( out[ 'faults' ] ).toEqual( [] );
			expect( out[ 'opsUnchecked' ] ).toBe( 40 );
			expect( ( out[ 'dynamic' ] as unknown[] ).length ).toBe( 1 );
		} finally { await scripted.stop(); }
	} );

	it( 'carries a fault whole, including every call site behind one verb', async () => {
		// The sites are the actionable half — a verb with nine of them is one edit in nine places, and a
		// carry that kept the verb and dropped the addresses would leave a reader grepping.
		await app.stop();
		const scripted = await new TestApp().callsAudit( {
			scanned: { roots: [ 'src/main' ], sites: 3, verbs: 1 },
			faults:  [ {
				verb: 'room_store.list', channel: 'room_store', op: 'list', kind: 'unrouted-channel',
				sites: [ { file: 'A.ts', line: 4 }, { file: 'B.ts', line: 71 } ], reason: 'nothing serves it'
			} ],
			dynamic: [], opsUnchecked: 0
		} ).listen();
		try {
			const out    = await json( 'audit_bus_calls' );
			const faults = out[ 'faults' ] as { kind: string; sites: unknown[] }[];
			expect( faults ).toHaveLength( 1 );
			expect( faults[ 0 ]!.kind ).toBe( 'unrouted-channel' );
			expect( faults[ 0 ]!.sites ).toHaveLength( 2 );
		} finally { await scripted.stop(); }
	} );

	it( 'keeps "could not see its own source" distinct from "found nothing wrong"', async () => {
		// A PACKAGED BUILD HAS NO TREE TO READ, and the empty fault list that comes back means UNCHECKED.
		// `scanned: null` is the only thing separating those two, so it has to survive the carry — a
		// reader who loses it concludes the app is clean on the strength of a scan that never ran.
		await app.stop();
		const scripted = await new TestApp().callsAudit( {
			scanned: null, faults: [],
			note:    'NO SOURCE TREE. This build cannot see its own source.'
		} ).listen();
		try {
			const out = await json( 'audit_bus_calls' );
			expect( out[ 'scanned' ] ).toBeNull();
			expect( String( out[ 'note' ] ) ).toContain( 'NO SOURCE TREE' );
		} finally { await scripted.stop(); }
	} );

	it( 'reports an app without the op as an older build, not as a clean audit', async () => {
		// The default TestApp scripts no audit, so the door 404s exactly as a build predating the op does.
		// The one answer this must never give is an empty fault list.
		const text = await refusal( 'audit_bus_calls' );
		expect( text ).toContain( 'no-door' );
	} );

	// ── The seam itself ──────────────────────────────────────────────────────────────────────

	it( 'reports an unrouted verb as the app answering, not as the app being unreachable', async () => {
		// The single most expensive confusion available at this seam: a verb nothing serves is a FINDING
		// about the app — a service failed to arm, or the verb was renamed — whereas a refused socket
		// means no verb ran and nothing was tested. A second app with nothing scripted on it, so the
		// door genuinely returns `unrouted` rather than the harness pretending to.
		await app.stop();
		const bare = await new TestApp().listen();
		try {
			const text = await refusal( 'list_decisions' );
			expect( text ).toContain( 'unrouted' );
			expect( text ).toContain( 'the app answered' );
			expect( text ).not.toContain( 'NOTHING WAS TESTED' );
		} finally { await bare.stop(); }
	} );

	// ── restart_app's SUPERVISION GUARD ( plan 1.i ) ────────────────────────────────────────────────
	//
	// The tool documented this hazard at length and did nothing about it, which left the whole burden on
	// a caller having read the doc and called `dev_status` first. An unsupervised restart brings main
	// back answering normally while the renderer dev server stays dead: a WHITE WINDOW with every signal
	// green, which is worse than a clean failure because the half that reports on itself is the half
	// that still works.
	describe( 'restart_app under and outside the supervisor', () => {

		it( 'restarts without argument when the app IS supervised', async () => {
			const out = await json( 'restart_app' );
			expect( out[ 'restarting' ] ).toBe( true );
			expect( out[ 'confirmWith' ] ).toContain( 'dev_status' );
		} );

		it( 'REFUSES when the app is not supervised, and says what would have happened', async () => {
			await app.stop();
			const solo = await new TestApp().host( { supervised: false, uptimeMs: 1000 } ).listen();
			try {
				// A refusal that arrives as a VALUE, not an error: "correctly declined" and "the rig broke"
				// must never be the same observable.
				const out = await json( 'restart_app' );
				expect( out[ 'restarted' ] ).toBe( false );
				expect( out[ 'refused' ] ).toBe( 'unsupervised' );
				expect( out[ 'why' ] ).toContain( 'WHITE WINDOW' );
				expect( out[ 'remedy' ] ).toContain( 'dev:proxied' );
			} finally { await solo.stop(); }
		} );

		it( 'proceeds unsupervised when the caller spells it in the call', async () => {
			await app.stop();
			const solo = await new TestApp().host( { supervised: false, uptimeMs: 1000 } ).listen();
			try {
				const out = await json( 'restart_app', { unsupervised: true } );
				expect( out[ 'restarting' ] ).toBe( true );
			} finally { await solo.stop(); }
		} );

		// ── AN UNREADABLE STATUS IS NOT PROOF OF ANYTHING. An app too old to report `supervised` must not
		// be treated as unsupervised: the guard binds only on a status that was actually read and actually
		// said false. Absence is not a failure, and it is not a verdict either.
		it( 'does not block when the app never reports the field', async () => {
			await app.stop();
			const quiet = await new TestApp().host( { uptimeMs: 1000 } ).listen();
			try {
				const out = await json( 'restart_app' );
				expect( out[ 'restarting' ] ).toBe( true );
			} finally { await quiet.stop(); }
		} );
	} );

	it( 'says NOTHING WAS TESTED when the app cannot be reached at all', async () => {
		await app.stop();
		process.env[ 'STARMIND_DEV_PORT' ] = '1';          // nothing listens on port 1
		const text = await refusal( 'list_sessions' );
		expect( text ).toContain( 'NOTHING WAS TESTED' );
		expect( text ).toContain( 'app-down' );
		// And it must NOT read as a finding about Starmind.
		expect( text ).not.toContain( 'unrouted' );
	} );
} );

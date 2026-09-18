import { createServer, type Server, type ServerResponse } from 'http';

/**
 * TestApp — a scripted Starmind, on a real socket.
 *
 * ── WHY A REAL SERVER AND NOT A DOUBLED DOOR ────────────────────────────────────────────────────
 *
 * The obvious test double is a fake `Door`: swap the client, assert on what the tools asked it. It
 * was refused, and the reason is written into this project's history rather than being a preference.
 * A tool once went green against a bus channel that did not exist, because the test doubled the thing
 * the tool talked to and therefore agreed with whatever the tool said. `FrontierRouter`'s own suite
 * answers this by driving a REAL router over a REAL loopback socket, and this is the mirror image of
 * that: the real `Door`, the real HTTP, the real JSON contract — and a scripted app on the far end.
 *
 * What that buys is specific. The door's reply shapes ( `ok` / `reason` / `undefinedValue` / status
 * codes ) are a contract between two packages that have no compile-time link at all: one lives in
 * `starmind`, the other here, and nothing but agreement about JSON holds them together. A doubled
 * Door would assert that this package agrees with itself. This asserts that it agrees with the wire.
 *
 * ── WHAT IT DELIBERATELY DOES NOT KNOW ──────────────────────────────────────────────────────────
 *
 * It holds no bus, no services and no notion of what a verb means. A verb is a name mapped to a
 * function that returns a value, because the question these tests ask is never "does the app work" —
 * it is "given what the app said, does the tool report the right thing". The app's own behaviour is
 * `starmind`'s suite to prove, and re-proving it here with a stub would be proving the stub.
 */

type VerbFn = ( ...args: unknown[] ) => unknown;

/** One thing that was asked of the app, in order. The record a test asserts the SEQUENCE against —
 *  `spawn` is three verbs in a fixed order, and "it called them" is a weaker claim than "it called
 *  them in the order the composer does". */
export interface Asked {
	verb: string;
	mode: string;
	args: unknown[];
}

export class TestApp {

	private _server: Server | null = null;
	private _port    = 0;
	private readonly _verbs    = new Map<string, VerbFn>();
	private readonly _commands = new Set<string>();
	/** channel -> { reads, writes, armed, fn }. Mirrors what `Channels` declares plus what PullGate holds,
	 *  because the door consults BOTH and a harness that merged them could not test the difference. */
	private readonly _pulls = new Map<string, { reads: string[]; writes: string[]; armed: boolean; sealed: string | null; fn: VerbFn }>();
	private _host: Record<string, unknown> = { supervised: true, uptimeMs: 1000 };
	/** What `/dev/calls` should answer. Null until a test scripts one — the door only grew this op
	 *  recently, and an app that does not have it must stay reachable so the OLDER-BUILD reply can be
	 *  tested too. */
	private _calls: Record<string, unknown> | null = null;

	/** Every call the app received, in order. */
	readonly asked: Asked[] = [];

	/** Script one `request` verb. Returning `undefined` is meaningful and is preserved end to end —
	 *  it is half of the distinction the door exists to keep. */
	verb( name: string, fn: VerbFn ): this {
		this._verbs.set( name, fn );
		return this;
	}

	/** Declare a command as emit-able. A name NOT declared here comes back `undeclared-command`, which
	 *  is what the real door does with a verb absent from the command vocabulary. */
	command( name: string ): this {
		this._commands.add( name );
		return this;
	}

	/** Declare a pull channel: which ops READ, which WRITE, whether a handler is armed for it, and whether
	 *  the DOOR is sealed to it ( the reason, which the refusal carries — `cred_store` is the live one ). */
	pull( channel: string, spec: { reads?: string[]; writes?: string[]; armed?: boolean; sealed?: string; fn?: VerbFn } ): this {
		this._pulls.set( channel, {
			reads:  spec.reads  ?? [],
			writes: spec.writes ?? [],
			armed:  spec.armed  ?? true,
			sealed: spec.sealed ?? null,
			fn:     spec.fn     ?? ( () => null )
		} );
		return this;
	}

	/** What `/dev/status` should answer. */
	host( fields: Record<string, unknown> ): this {
		this._host = fields;
		return this;
	}

	/** Script the `/dev/calls` audit reply. The APP performs that audit — it owns both halves, the live
	 *  registry and the routing rule — so what is scriptable here is its ANSWER, and what the tests
	 *  ask is whether the tool carries that answer across without flattening it. */
	callsAudit( payload: Record<string, unknown> ): this {
		this._calls = payload;
		return this;
	}

	/**
	 * Listen on an ephemeral port and point the Door at it.
	 *
	 * `STARMIND_DEV_PORT` is set rather than the config being edited, because that env var is the
	 * documented single-candidate override — a test that used the two-port probe would be racing
	 * whatever is actually running on the developer's machine, which is the least reproducible
	 * possible arrangement for a test suite.
	 */
	async listen(): Promise<this> {
		this._server = createServer( ( req, res ) => {
			let body = '';
			req.on( 'data', ( c: Buffer ) => { body += c.toString( 'utf8' ); } );
			req.on( 'end', () => this._route( req.url ?? '', body, res ) );
		} );
		await new Promise<void>( ( done ) => this._server!.listen( 0, '127.0.0.1', done ) );
		const addr = this._server.address();
		this._port = addr && typeof addr === 'object' ? addr.port : 0;
		process.env[ 'STARMIND_DEV_PORT' ]  = String( this._port );
		process.env[ 'STARMIND_DEV_TOKEN' ] = 'test-dev-token';
		return this;
	}

	async stop(): Promise<void> {
		delete process.env[ 'STARMIND_DEV_PORT' ];
		if ( !this._server ) return;
		await new Promise<void>( ( done ) => this._server!.close( () => done() ) );
		this._server = null;
	}

	private _route( url: string, body: string, res: ServerResponse ): void {
		const send = ( code: number, payload: unknown ): void => {
			res.writeHead( code, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( payload ) );
		};

		if ( url === '/dev/status' )  { send( 200, { ok: true, ...this._host } ); return; }
		if ( url === '/dev/restart' ) { send( 200, { ok: true, restarting: true, inMs: 250 } ); return; }
		if ( url === '/dev/verbs' ) {
			// THE SAME THREE LISTS THE REAL DOOR SENDS, in the same SHAPE. A harness that answered a simpler
			// shape here would let the surface index pass its tests and fail against the app — which is exactly
			// the double-entry failure the thing under test exists to prevent, committed by its own harness.
			const served = [ ...new Set( [ ...this._verbs.keys() ].map( ( v ) => v.slice( 0, v.lastIndexOf( '.' ) ) ) ) ]
				.map( ( channel ) => ( { channel, ops: [ ...this._verbs.keys() ].filter( ( v ) => v.startsWith( channel + '.' ) ).map( ( v ) => v.slice( channel.length + 1 ) ) } ) );
			const commands = [ ...this._commands ].map( ( name ) => ( { name, lane: 'render→main', desc: '', schema: null } ) );
			const pulls = [ ...this._pulls.entries() ].map( ( [ channel, e ] ) => ( { channel, armed: e.armed, reads: [ ...e.reads ], writes: [ ...e.writes ] } ) );
			send( 200, { ok: true, served, commands, pulls, shapes: { shaped: commands.length, unshaped: 0, note: 'scripted' } } );
			return;
		}
		if ( url === '/dev/calls' ) {
			// AN APP WITHOUT THE OP ANSWERS 404, exactly as an older build does. That is a distinct outcome
			// from a clean audit and the tool has to report it as one.
			if ( !this._calls ) { send( 404, { error: 'no such dev op: calls' } ); return; }
			send( 200, { ok: true, ...this._calls } );
			return;
		}
		if ( url === '/dev/pull' ) {
			const c = JSON.parse( body ) as { channel: string; op: string; args?: unknown; allowWrites?: boolean };
			this.asked.push( { verb: `${ c.channel }.${ c.op }`, mode: 'pull', args: [ c.args ] } );
			const entry = this._pulls.get( c.channel );
			// The door's own order: SEALED? then declared? then asked-for? then armed? then dispatch. Reproduced
			// rather than simplified, because the ORDER is what keeps the answers distinct — and the seal sits
			// at the top for a reason worth mirroring: below the registration check, an invented op on a sealed
			// channel would answer `unregistered` while a real one answered `sealed`, and the door would be
			// confirming which ops exist on the one channel it refuses to discuss.
			if ( entry?.sealed ) { send( 200, { ok: false, reason: 'sealed', channel: c.channel, op: c.op, detail: entry.sealed } ); return; }
			if ( !entry || ![ ...entry.reads, ...entry.writes ].includes( c.op ) ) { send( 200, { ok: false, reason: 'unregistered', channel: c.channel, op: c.op, detail: 'not declared' } ); return; }
			// A LANE CHECK, NOT A CAPABILITY ONE — the real door serves writes and refuses only to perform one
			// for a caller that did not ask. Scripted the same way so the two tools stay distinguishable here.
			if ( entry.writes.includes( c.op ) && c.allowWrites !== true ) { send( 200, { ok: false, reason: 'write-refused', channel: c.channel, op: c.op, detail: 'a declared write, reached read-only' } ); return; }
			if ( !entry.armed ) { send( 200, { ok: false, reason: 'unarmed', channel: c.channel, op: c.op, detail: 'nothing serving it' } ); return; }
			const v = entry.fn( c.args );
			send( 200, { ok: true, channel: c.channel, op: c.op, value: v ?? null, undefinedValue: v === undefined } );
			return;
		}
		if ( url !== '/dev/verb' )    { send( 404, { error: `no such dev op` } ); return; }

		const call = JSON.parse( body ) as { verb: string; args?: unknown[]; mode?: string };
		const mode = call.mode ?? 'request';
		this.asked.push( { verb: call.verb, mode, args: call.args ?? [] } );

		if ( mode === 'emit' ) {
			if ( !this._commands.has( call.verb ) ) { send( 200, { ok: false, reason: 'undeclared-command', verb: call.verb, detail: 'not in the vocabulary' } ); return; }
			send( 200, { ok: true, verb: call.verb, mode, accepted: true } );
			return;
		}

		const fn = this._verbs.get( call.verb );
		// UNROUTED IS NOT UNDEFINED — the same separation the real door makes, reproduced here because a
		// harness that collapsed them would make the tools' handling of the distinction untestable.
		if ( !fn ) { send( 200, { ok: false, reason: 'unrouted', verb: call.verb, detail: 'nothing serves that channel' } ); return; }

		try {
			const value = fn( ...( call.args ?? [] ) );
			send( 200, { ok: true, verb: call.verb, mode, value: value ?? null, undefinedValue: value === undefined } );
		} catch ( err ) {
			send( 200, { ok: false, reason: 'threw', verb: call.verb, detail: err instanceof Error ? err.message : String( err ) } );
		}
	}
}

/** One agent row, wire-shaped. Only the fields these tests actually read — a fixture that filled in
 *  every field would suggest the tools depend on more of the shape than they do. */
/**
 * One serialized agent, in the shape `Agent.fromSerialized` actually takes.
 *
 * TWO AXES SINCE 2026-08-26, and the double follows the product rather than the other way round.
 * `toolPolicies` says whether a tool MAY RUN — presence is the allowance, and a denial is ABSENCE rather
 * than an `off` sitting in the map. `toolSurfaces` says how much of a held tool rides in the prompt:
 * `manifest` is a name and a line, `preload` is the full schema up front. `preloadedToolIds()` reads the
 * second, which is what the renderer sends as `toolNames`.
 *
 * The single `toolModes` map this replaced could not express that split, and a double still speaking it
 * would satisfy assertions the app can no longer produce — which is the exact failure this file already
 * carries a warning about one function down.
 */
export function agentRow(
	id: string, name: string,
	toolPolicies: Record<string, string> = {},
	toolSurfaces: Record<string, string> = {}
): Record<string, unknown> {
	return {
		id, name, projectId: 'p1', icon: '', color: '', model: null, systemPrompt: '',
		lenses: [], baseTools: [], baseHabits: [], baseReferences: [], basePlans: [],
		toolPolicies, toolSurfaces,
		referenceOff: [], referenceModes: {}, habitOff: [], habitModes: {},
		fields: [], system: {}, createdAt: 0, folder: null, notes: '',
		baseHabitNodes: [], baseReferenceNodes: []
	};
}

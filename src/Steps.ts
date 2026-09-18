import { Door, isOk, unreached, type DoorReply } from './Door';
import { parseAddress } from './Address';
import { Surface, type SurfaceMap } from './Surface';

/**
 * Steps — the fluent interface's execution half: a flat list of crossings, run in order against the
 * live app, each one adjudicated.
 *
 * ── A STEP IS DATA, NOT A CALL ────────────────────────────────────────────────────────────────
 *
 * The point of this arc is that a modest model can author an integration test COLD. That rules out a
 * chained builder API ( which needs the authoring context to hold the whole vocabulary ) and rules in
 * a flat record: one address, one payload, one optional binding, one optional expectation. Everything
 * a step can do is visible in the record, so a sequence can be reviewed by a person who has never
 * read this file.
 *
 * ── BINDINGS, WHICH ARE WHY THIS IS A SEQUENCE AND NOT FOUR TOOL CALLS ────────────────────────
 *
 * `as` names a result; `$name` and `$name.path.into.it` reference one in a later step's payload. That
 * is the whole reason a sequence exists — an id minted by step 1 has to reach step 4 without a person
 * copying it. Substitution happens INSIDE the payload, argument by argument, so a binding can be one
 * field of an object, one element of a positional list, or the entire payload.
 *
 * ── WHAT IT REFUSES BEFORE IT RUNS ANYTHING ───────────────────────────────────────────────────
 *
 * Every address is resolved against the app's live registries FIRST, and a sequence with a bad address
 * does not start. This matters more here than anywhere else on this surface: steps MUTATE, so
 * discovering a typo at step 4 means the app has already been changed by steps 1 through 3 and the run
 * has to be cleaned up by hand. Authoring-time refusal is not politeness, it is the difference between
 * a failed test and a dirty app.
 */

export interface Expectation {
	/** Deep equality against the whole value. */
	equals?:   unknown;
	/** JSON-substring match — the loose one, for when only a fragment is interesting. */
	contains?: string;
	/** The value is an object carrying at least these keys. */
	hasKeys?:  string[];
	/** Distinguishes a real null from a value, which this surface keeps apart everywhere else. */
	isNull?:   boolean;
	notNull?:  boolean;
	/** Array length. */
	count?:    number;
}

export interface Step {
	/** An address — `bus:` · `pull:` · `write:` · `emit:`. Exactly one of call / wait / crossed. */
	call?:    string;
	/** Wait for a session to finish a turn. `{ session, afterTurns?, timeoutMs? }`. */
	wait?:    Record<string, unknown>;
	/** Assert a trace source appeared. `{ source, channel?, min? }`. */
	crossed?: Record<string, unknown>;
	args?:    unknown;
	as?:      string;
	expect?:  Expectation;
	/** Free text carried into the report — why this step is here, in the author's words. */
	note?:    string;
}

export interface StepResult {
	index:   number;
	step:    string;
	ok:      boolean;
	value?:  unknown;
	bound?:  string;
	failure?: string;
	/** Set when the app was never reached, so this step proved nothing about it. */
	unreached?: boolean;
	ms:      number;
}

/** Follow `a.b.c` into a value. Returns undefined for any miss, which the caller reports as a
 *  binding failure rather than substituting `undefined` and letting it travel. */
function dig( value: unknown, path: string[] ): unknown {
	let at: unknown = value;
	for ( const key of path ) {
		if ( at === null || typeof at !== 'object' ) return undefined;
		at = ( at as Record<string, unknown> )[ key ];
	}
	return at;
}

/**
 * Replace every `$binding` in a payload, at any depth.
 *
 * A WHOLE-STRING `$ref` YIELDS THE VALUE ITSELF, not its text. `"$s.id"` becomes the id; `"id-$s.id"`
 * becomes a string. Without that split a bound number or object could only ever arrive as text, and a
 * step passing `"[object Object]"` to a handler would fail somewhere far from the cause.
 *
 * AN UNRESOLVED BINDING THROWS rather than passing through. A `$typo` that travelled as the literal
 * string `"$typo"` would reach a handler, be coerced, and produce a plausible wrong result — which is
 * exactly the class of failure this whole surface exists to make impossible.
 */
function substitute( payload: unknown, bindings: Map<string, unknown> ): unknown {
	if ( typeof payload === 'string' ) {
		if ( !payload.includes( '$' ) ) return payload;

		const whole = /^\$([A-Za-z_][\w]*)((?:\.[\w]+)*)$/.exec( payload );
		if ( whole ) {
			const name = whole[ 1 ]!;
			if ( !bindings.has( name ) ) throw new Error( `no binding named "${ name }" — bind it with \`as\` on an earlier step. Bound so far: ${ [ ...bindings.keys() ].join( ', ' ) || 'nothing' }` );
			const path = whole[ 2 ] ? whole[ 2 ].slice( 1 ).split( '.' ) : [];
			const got  = dig( bindings.get( name ), path );
			if ( got === undefined ) throw new Error( `binding "${ payload }" resolved to nothing — "${ name }" is bound, but the path is not in it.` );
			return got;
		}

		return payload.replace( /\$([A-Za-z_][\w]*)((?:\.[\w]+)*)/g, ( _m, name: string, rest: string ) => {
			if ( !bindings.has( name ) ) throw new Error( `no binding named "${ name }" in "${ payload }".` );
			const got = dig( bindings.get( name ), rest ? rest.slice( 1 ).split( '.' ) : [] );
			if ( got === undefined ) throw new Error( `binding "$${ name }${ rest }" resolved to nothing.` );
			return String( got );
		} );
	}
	if ( Array.isArray( payload ) ) return payload.map( ( item ) => substitute( item, bindings ) );
	if ( payload && typeof payload === 'object' ) {
		const out: Record<string, unknown> = {};
		for ( const [ k, v ] of Object.entries( payload as Record<string, unknown> ) ) out[ k ] = substitute( v, bindings );
		return out;
	}
	return payload;
}

/** Adjudicate one expectation. Returns null when satisfied, or prose naming what was wanted and what
 *  arrived — a failed assertion is read by whoever has to fix it, so it says both. */
function judge( value: unknown, want: Expectation ): string | null {
	const seen = JSON.stringify( value ) ?? 'undefined';
	if ( want.isNull  === true && value !== null ) return `expected null, got ${ seen.slice( 0, 300 ) }`;
	if ( want.notNull === true && value === null ) return 'expected a value, got null';
	if ( want.equals !== undefined ) {
		if ( JSON.stringify( want.equals ) !== seen ) return `expected ${ JSON.stringify( want.equals ).slice( 0, 300 ) }, got ${ seen.slice( 0, 300 ) }`;
	}
	if ( want.contains !== undefined && !seen.includes( want.contains ) ) return `expected the result to contain "${ want.contains }", got ${ seen.slice( 0, 300 ) }`;
	if ( want.hasKeys ) {
		if ( !value || typeof value !== 'object' ) return `expected an object with keys ${ want.hasKeys.join( ', ' ) }, got ${ seen.slice( 0, 200 ) }`;
		const missing = want.hasKeys.filter( ( k ) => !( k in ( value as Record<string, unknown> ) ) );
		if ( missing.length ) return `missing key(s): ${ missing.join( ', ' ) }. Present: ${ Object.keys( value as object ).join( ', ' ) }`;
	}
	if ( want.count !== undefined ) {
		if ( !Array.isArray( value ) ) return `expected an array of ${ want.count }, got ${ typeof value }`;
		if ( value.length !== want.count ) return `expected ${ want.count } item(s), got ${ value.length }`;
	}
	return null;
}

/** Send one addressed crossing through the door. The ONE place a lane becomes a call, so the mapping
 *  from address to transport is written once and cannot drift between step kinds. */
async function cross( address: string, args: unknown ): Promise<DoorReply> {
	const parsed = parseAddress( address );
	if ( 'error' in parsed ) throw new Error( parsed.error );
	const { lane, target, channel, op } = parsed;

	// POSITIONAL VERSUS OBJECT IS THE LANE'S OWN FACT, not a caller preference. A bus verb takes a
	// positional list; a pull op takes one object; a command takes one payload. A caller that hands a
	// bus verb an object gets told so rather than having it stringified into "[object Object]".
	if ( lane === 'bus' ) {
		if ( args !== undefined && !Array.isArray( args ) ) {
			throw new Error( `\`${ address }\` is a BUS verb and takes POSITIONAL arguments — pass \`args\` as a list, in the handler's own order. Bus parameter names and order are published nowhere, so an object cannot be mapped onto one; describe_surface says as much for every bus address.` );
		}
		return Door.request( target, ...( ( args as unknown[] ) ?? [] ) );
	}
	if ( lane === 'emit' )  return Door.emit( target, args ?? {} );
	if ( lane === 'write' ) return Door.write( channel!, op!, args );
	return Door.pull( channel!, op!, args );
}

export interface RunReport {
	name:     string;
	ok:       boolean;
	ran:      number;
	planned:  number;
	steps:    StepResult[];
	bindings: string[];
	stopped?: string;
}

export const Steps = new class Steps {

	/**
	 * Check every address BEFORE running anything, and report all the problems rather than the first.
	 *
	 * ALL OF THEM, because an author fixing a sequence wants the list — returning one error at a time
	 * turns a four-typo sequence into four round trips, and this surface is meant to be driven by
	 * something that pays for each one.
	 */
	async validate( steps: Step[] ): Promise<string[]> {
		const map = await Surface.load();
		if ( 'error' in map ) return [ map.error ];

		const problems: string[] = [];
		const bound = new Set<string>();

		steps.forEach( ( step, i ) => {
			const at = `step ${ i + 1 }`;
			const kinds = [ step.call, step.wait, step.crossed ].filter( ( k ) => k !== undefined );
			if ( kinds.length !== 1 ) {
				problems.push( `${ at }: needs exactly one of \`call\`, \`wait\` or \`crossed\` — found ${ kinds.length }.` );
				return;
			}

			if ( step.call ) {
				const doc = Surface.describe( map as SurfaceMap, step.call );
				if ( 'error' in doc ) problems.push( `${ at }: ${ doc.error }` );
				else if ( doc.lane === 'emit' && step.expect ) {
					// AN EMIT HAS NO RESULT TO ASSERT ON, and letting one carry an expectation would produce a
					// test that passes on a fire-and-forget call having merely been ACCEPTED. That is the
					// single easiest way for a fluent interface to lie about what it verified.
					problems.push( `${ at }: \`${ step.call }\` is an EMIT and returns nothing to assert on — it is accepted, not finished. Put the expectation on a later \`pull:\` step that reads the effect, or on a \`crossed\` step.` );
				}
			}
			if ( step.as ) bound.add( step.as );

			// Bindings are checked in ORDER, so a step referencing a name bound LATER is caught here
			// rather than at run time — which for a mutating sequence is the difference between a
			// refusal and a half-applied change.
			for ( const ref of this._refs( step.args ) ) {
				if ( !bound.has( ref ) ) problems.push( `${ at }: references \`$${ ref }\`, which no earlier step binds. Bind it with \`as\` before using it.` );
			}
		} );
		return problems;
	}

	/** Every `$name` mentioned anywhere in a payload. */
	private _refs( payload: unknown, out = new Set<string>() ): Set<string> {
		if ( typeof payload === 'string' ) {
			for ( const m of payload.matchAll( /\$([A-Za-z_][\w]*)/g ) ) out.add( m[ 1 ]! );
		} else if ( Array.isArray( payload ) ) {
			for ( const item of payload ) this._refs( item, out );
		} else if ( payload && typeof payload === 'object' ) {
			for ( const v of Object.values( payload as Record<string, unknown> ) ) this._refs( v, out );
		}
		return out;
	}

	/**
	 * Run the sequence, stopping at the first failure.
	 *
	 * STOPPING IS THE RIGHT DEFAULT AND IS NOT OBVIOUS. Steps are ordered because they depend on each
	 * other; continuing past a failed arrange produces a cascade of failures that all name the same
	 * root cause and bury it. The report says how many steps were PLANNED against how many RAN, so a
	 * short report is legible as a stop rather than as a short sequence.
	 */
	async run( name: string, steps: Step[] ): Promise<RunReport> {
		const bindings = new Map<string, unknown>();
		const results: StepResult[] = [];
		let stopped: string | undefined;

		for ( let i = 0; i < steps.length; i++ ) {
			const step = steps[ i ]!;
			const label = step.call ?? ( step.wait ? 'wait' : 'crossed' );
			const began = Date.now();

			try {
				const args = substitute( step.args, bindings );
				const outcome = step.call
					? await this._call( step.call, args )
					: step.wait
						? await this._wait( substitute( step.wait, bindings ) as Record<string, unknown> )
						: await this._crossed( substitute( step.crossed, bindings ) as Record<string, unknown> );

				if ( 'failure' in outcome ) {
					results.push( { index: i + 1, step: label, ok: false, failure: outcome.failure, unreached: outcome.unreached, ms: Date.now() - began } );
					stopped = `step ${ i + 1 } ( ${ label } ) failed`;
					break;
				}

				const bad = step.expect ? judge( outcome.value, step.expect ) : null;
				if ( bad ) {
					results.push( { index: i + 1, step: label, ok: false, value: outcome.value, failure: `expectation not met — ${ bad }`, ms: Date.now() - began } );
					stopped = `step ${ i + 1 } ( ${ label } ) failed its expectation`;
					break;
				}

				if ( step.as ) bindings.set( step.as, outcome.value );
				results.push( { index: i + 1, step: label, ok: true, value: outcome.value, bound: step.as, ms: Date.now() - began } );
			} catch ( err ) {
				const why = err instanceof Error ? err.message : String( err );
				results.push( { index: i + 1, step: label, ok: false, failure: why, ms: Date.now() - began } );
				stopped = `step ${ i + 1 } ( ${ label } ) could not be prepared: ${ why }`;
				break;
			}
		}

		return {
			name,
			ok:       results.length === steps.length && results.every( ( r ) => r.ok ),
			ran:      results.length,
			planned:  steps.length,
			steps:    results,
			bindings: [ ...bindings.keys() ],
			...( stopped ? { stopped } : {} )
		};
	}

	private async _call( address: string, args: unknown ): Promise<{ value: unknown } | { failure: string; unreached?: boolean }> {
		const reply = await cross( address, args );
		if ( reply.outcome === 'accepted' ) return { value: { accepted: true } };
		if ( !isOk( reply ) ) {
			const detail = 'detail' in reply ? reply.detail : '';
			return { failure: `[ ${ reply.outcome } ] ${ detail }`, ...( unreached( reply ) ? { unreached: true } : {} ) };
		}
		return { value: reply.value };
	}

	/** The completion signal as a step. Deliberately the SAME two reads `wait_for_turn` makes rather
	 *  than a second implementation — one of them being subtly different is how a sequence would come
	 *  to disagree with the tool a person calls by hand. */
	private async _wait( args: Record<string, unknown> ): Promise<{ value: unknown } | { failure: string; unreached?: boolean }> {
		const sessionId = String( args[ 'session' ] ?? args[ 'sessionId' ] ?? '' );
		if ( !sessionId ) return { failure: 'a `wait` step needs a `session`.' };
		const timeoutMs = Number( args[ 'timeoutMs' ] ?? 170_000 );
		const baseline  = typeof args[ 'afterTurns' ] === 'number' ? args[ 'afterTurns' ] as number : null;

		const startedAt = Date.now();
		const pollMs = Math.max( 25, Math.min( 1_000, Math.floor( timeoutMs / 20 ) ) );
		let base = baseline;
		let sawThinking = false;

		for ( ;; ) {
			const row = await Door.pull( 'session_store', 'get', { id: sessionId } );
			if ( !isOk( row ) ) {
				const detail = 'detail' in row ? row.detail : '';
				return { failure: `[ ${ row.outcome } ] ${ detail }`, ...( unreached( row ) ? { unreached: true } : {} ) };
			}
			const session = row.value as { turnStatus?: string } | null;
			if ( !session ) return { failure: `session "${ sessionId }" does not exist. The app answered — it may have been deleted mid-sequence.` };
			if ( session.turnStatus === 'thinking' ) sawThinking = true;

			if ( session.turnStatus !== 'thinking' ) {
				const turns = await Door.request( 'communication.turns', sessionId );
				if ( !isOk( turns ) ) return { failure: 'could not read turns while waiting.' };
				const count = ( turns.value as unknown[] | null )?.length ?? 0;
				if ( base === null ) base = count;                    // no baseline given: adopt and wait for growth
				else if ( count > base ) return { value: { finished: true, turns: count, waitedMs: Date.now() - startedAt, sawThinking } };
			}

			if ( Date.now() - startedAt >= timeoutMs ) {
				return { failure: sawThinking
					? `waited ${ timeoutMs }ms and the turn was still running. Slow, not lost — raise timeoutMs.`
					: `waited ${ timeoutMs }ms and the session never left \`idle\`, so THE TURN NEVER STARTED. Pass \`afterTurns\` from the spawn step to rule out a baseline taken too late.` };
			}
			await new Promise( ( go ) => setTimeout( go, pollMs ) );
		}
	}

	/**
	 * Assert a trace source appeared — the observation primitive.
	 *
	 * ── WHAT THIS SEES ──
	 *
	 * It reads the app's own trace channels, so it sees anything the app TRACES: the door's every act
	 * ( `dev_door.write`, `dev_door.pull`, `dev_door.refused` ), every service line, and
	 * `debug_schema_failure` for a payload the Bridge DROPPED.
	 *
	 * IT CAN NOW SEE A SUCCESSFUL BRIDGE CROSSING. It could not, and the note here used to say so: the
	 * Bridge recorded only its failures, so a clean crossing left no line and "found 0" meant either that
	 * nothing arrived or that everything arrived. `BRIDGE.EVENT.IN` closed that, which is what makes
	 * `crossed` a real answer for an injected command rather than one for verbs whose HANDLER happens to
	 * trace. Look on the channel belonging to the RECEIVING side — `render` for a `main→render` command,
	 * `server` for `render→main` — since each process files its own receipt.
	 *
	 * ── THE ARMING TRAP, WHICH IS WHY ZERO IS TWO ANSWERS ──
	 *
	 * BRIDGE is off unless armed, so a search for a receipt in an unarmed app finds nothing and would
	 * report "it did not cross" over an app where it crossed perfectly — the exact defect just fixed,
	 * reintroduced one layer up. So a zero is not reported until the arming map has been ASKED. An
	 * unarmed area comes back as its own outcome naming the fix, never as a failed assertion.
	 *
	 * AND THE ARMING MAP THIS CAN SEE IS MAIN'S. The renderer runs an adopted copy refreshed on a poll,
	 * so a renderer-side zero is never called "a real absence" — it may simply have been caused inside
	 * the adoption window, and no amount of waiting afterwards creates a line that was gated at the
	 * moment of the call.
	 */
	private async _crossed( args: Record<string, unknown> ): Promise<{ value: unknown } | { failure: string; unreached?: boolean }> {
		const source  = String( args[ 'source' ] ?? '' );
		const channel = String( args[ 'channel' ] ?? 'capability' );
		const min     = Number( args[ 'min' ] ?? 1 );
		const waitMs  = Number( args[ 'timeoutMs' ] ?? 3000 );
		if ( !source ) return { failure: 'a `crossed` step needs a `source` — the trace source to look for, e.g. "dev_door.write" or "BRIDGE.EVENT.IN".' };

		// ── IT POLLS, BECAUSE A TRACE LINE IS NOT WRITTEN WHERE IT IS CAUSED.
		//
		// Measured on the first live run of this step: an `emit:` finished in 3ms, this assertion ran 1ms
		// later, and reported a real crossing as ABSENT. The receipt for a `main→render` command is written
		// by the RENDERER, relayed over the pull lane to main, and only then appended to a file — so reading
		// once, immediately, races a journey across a process boundary and a disk write. The line was on
		// disk moments later and the identical assertion passed.
		//
		// A read-once assertion here does not merely flake: it reports the OPPOSITE of what happened, and
		// it does so most often for exactly the crossings this step exists to prove.
		const until = Date.now() + Math.max( 0, waitMs );
		let total   = 0;
		for ( ;; ) {
			const found = await Door.pull( 'trace', 'search', { channel, query: source, count: 200 } );
			if ( !isOk( found ) ) {
				const detail = 'detail' in found ? found.detail : '';
				return { failure: `[ ${ found.outcome } ] ${ detail }`, ...( unreached( found ) ? { unreached: true } : {} ) };
			}
			total = ( found.value as { total?: number } | null )?.total ?? 0;
			if ( total >= min ) return { value: { source, channel, total, waitedMs: waitMs - ( until - Date.now() ) } };
			if ( Date.now() >= until ) break;
			await new Promise( ( go ) => setTimeout( go, 100 ) );
		}

		// ONLY ON A ZERO, so the ordinary passing path costs nothing. The question is asked at the moment
		// it changes the meaning of the answer, and not before.
		const area    = source.split( '.' )[ 0 ] ?? '';
		const unarmed = await this._unarmed( area );
		if ( unarmed ) {
			return { failure: `waited ${ waitMs }ms and found no \`${ source }\` line(s), and the \`${ area }\` trace area is NOT ARMED — so this proves nothing either way. ${ unarmed } Arm it with a \`write:\` step on \`trace.arm\` BEFORE the crossing you want to observe, then run again.` };
		}

		// ── ARMED IN MAIN IS NOT ARMED IN THE RENDERER, AND ONLY THE FIRST IS KNOWABLE FROM HERE.
		//
		// `trace.arming` reports MAIN's map. The renderer holds an adopted copy, refreshed by `ArmingSync`
		// on a poll — so for up to one interval after arming, main says yes and the renderer is still
		// silent. A line written by the renderer during that window never exists, and no later polling can
		// conjure it, because arming gates at the moment of the call rather than at the moment of the read.
		//
		// So this refuses to call a renderer-side zero "a real absence". Claiming it confidently would be
		// the same defect this whole item closed — an answer that cannot tell two states apart, delivered
		// as though it could.
		const renderSide = channel === 'render';
		return { failure: `waited ${ waitMs }ms and found ${ total } \`${ source }\` line(s) on the \`${ channel }\` trace channel, expected at least ${ min }. The \`${ area }\` area is armed in MAIN.` + ( renderSide
			? ` This channel is written by the RENDERER, which adopts main's armed set on a poll — so if the area was armed shortly before the crossing, it was not yet live over there and the line was never written. Arming cannot be applied retroactively: arm, let a few seconds pass, THEN cause the crossing.`
			: ` That is this side's own map, so this is a real absence: nothing wrote that line.` ) };
	}

	/**
	 * Is the area that would have written this line switched off? Returns prose naming what IS armed, or
	 * null when the area is armed and a zero therefore means what it says.
	 *
	 * CONTAINED, AND SILENT ON FAILURE. This runs only to explain a result that has already been decided,
	 * so a door that cannot answer must not turn a plain failed assertion into an error about arming.
	 * Unknown means "do not add a claim", never "assume the worst".
	 */
	private async _unarmed( area: string ): Promise<string | null> {
		if ( !area || area !== area.toUpperCase() ) return null;   // not a TRACE verb; arming does not apply
		const reply = await Door.pull( 'trace', 'arming' );
		if ( !isOk( reply ) ) return null;

		const armed = ( reply.value as { armed?: string[] } | null )?.armed;
		if ( !Array.isArray( armed ) ) return null;
		if ( armed.includes( area ) ) return null;
		return `Armed right now: ${ armed.length ? armed.join( ', ' ) : 'nothing beyond the always-on floor' }.`;
	}
}();

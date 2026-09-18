import { Door, isOk } from './Door';
import { parseAddress, type Address, type Lane } from './Address';

/**
 * Surface — the app's callable vocabulary, read off the app's own registries.
 *
 * ── THE ONE RULE: THIS FILE KEEPS NO LIST ─────────────────────────────────────────────────────
 *
 * Every name here arrives over `/dev/verbs`, which reads `MainBus`'s live dispatch map, the
 * `Commands` vocabulary and the `Channels` table. Nothing is transcribed, mirrored or defaulted. A
 * verb-keyed testing rig is a string-keyed testing rig, and the failure mode of string keys is a
 * second copy that was right on the day it was written — so there is no second copy. If the app
 * renames an op, a sequence naming the old one fails at AUTHORING TIME with a suggestion, rather
 * than at run time with a refusal that looks like a bug in the app.
 *
 * ── WHAT IS KNOWN PER LANE, WHICH IS NOT THE SAME THING ───────────────────────────────────────
 *
 * `emit` carries a JSON Schema for its payload — `CommandVocabulary` was built self-describing, every
 * entry holds a zod schema the Bridge already validates on both sides, and the door converts it. All
 * 55 commands can therefore be authored against blind and checked before a single byte is sent.
 *
 * `bus`, `pull` and `write` carry NAMES ONLY. Their argument shapes exist exclusively as destructuring
 * inside each handler ( `String( args[ 'id' ] ?? '' )` ), so nothing can publish them without someone
 * writing them down a second time. Bus verbs are additionally POSITIONAL, so even the parameter ORDER
 * is unpublished — which is why this surface cannot map a named payload onto a bus call and says so
 * instead of guessing an order.
 *
 * THAT ASYMMETRY IS REPORTED, NOT PAPERED OVER. `shapes` carries the count both ways. The fix is to
 * declare shapes where the ops are already declared — exactly what `Commands` does — and every op that
 * gains one moves the number with no change here. A hand-written shape table in THIS package would
 * make the number look better and the system worse.
 */

export interface CommandEntry {
	name:   string;
	lane:   string;
	desc:   string;
	schema: unknown;
}

export interface PullEntry {
	channel: string;
	armed:   boolean;
	reads:   string[];
	writes:  string[];
}

export interface ServedEntry {
	channel: string;
	/** null = the channel routes a parametric op space and cannot name its ops. NOT an empty list. */
	ops: string[] | null;
}

export interface SurfaceMap {
	served:   ServedEntry[];
	commands: CommandEntry[];
	pulls:    PullEntry[];
	shapes?:  { shaped: number; unshaped: number; note: string };
}

/** What a caller may pass, and how much of that is actually known rather than assumed. */
export interface VerbDoc {
	address:  string;
	lane:     Lane;
	exists:   boolean;
	/** `false` when the lane publishes names only — the caller is authoring blind and should be told. */
	shaped:   boolean;
	/** How arguments are passed on this lane: an object, a positional list, or one payload. */
	argStyle: 'object' | 'positional' | 'payload';
	desc:     string;
	schema:   unknown;
	notes:    string[];
}

/** Levenshtein, small and local. A near-miss on a string key is the single most common authoring
 *  error on a surface like this, and answering "no such op" without answering "did you mean" wastes
 *  the one round trip where the caller still remembers what they meant. */
function distance( a: string, b: string ): number {
	const prev: number[] = Array.from( { length: b.length + 1 }, ( _, i ) => i );
	for ( let i = 1; i <= a.length; i++ ) {
		let carry = prev[ 0 ]!;
		prev[ 0 ] = i;
		for ( let j = 1; j <= b.length; j++ ) {
			const next = Math.min(
				prev[ j ]! + 1,
				prev[ j - 1 ]! + 1,
				carry + ( a[ i - 1 ] === b[ j - 1 ] ? 0 : 1 )
			);
			carry = prev[ j ]!;
			prev[ j ] = next;
		}
	}
	return prev[ b.length ]!;
}

export const Surface = new class Surface {

	/** One fetch per process by default. The vocabulary is a fact about the BUILD, not about the run —
	 *  a restart can change it, and `refresh` is how a caller that just restarted the app says so. */
	private _map: SurfaceMap | null = null;

	async load( refresh = false ): Promise<SurfaceMap | { error: string }> {
		if ( this._map && !refresh ) return this._map;
		const reply = await Door.verbs();
		if ( !isOk( reply ) ) {
			const detail = 'detail' in reply ? reply.detail : '';
			return { error: `could not read the app's surface [ ${ reply.outcome } ]. ${ detail }` };
		}
		this._map = reply.value as SurfaceMap;
		return this._map;
	}

	/** Every address the app can be called at, as flat strings. The authoring index. */
	addresses( map: SurfaceMap ): string[] {
		const out: string[] = [];
		for ( const s of map.served ) for ( const op of s.ops ?? [] ) out.push( `bus:${ s.channel }.${ op }` );
		for ( const p of map.pulls ) {
			for ( const op of p.reads )  out.push( `pull:${ p.channel }.${ op }` );
			for ( const op of p.writes ) out.push( `write:${ p.channel }.${ op }` );
		}
		for ( const c of map.commands ) out.push( `emit:${ c.name }` );
		return out;
	}

	/**
	 * Does this address exist, and what is known about it.
	 *
	 * EXISTENCE AND SHAPE ARE TWO ANSWERS, and collapsing them is the mistake this whole file guards
	 * against. "That op is not declared" sends an author to the registry; "that op is declared and
	 * nobody published its arguments" sends them to the handler source. Reporting the second as the
	 * first would be a confident wrong answer, which is the defect shape this project keeps catching.
	 */
	describe( map: SurfaceMap, raw: string ): VerbDoc | { error: string } {
		const parsed = parseAddress( raw );
		if ( 'error' in parsed ) return parsed;
		const { lane, channel, op } = parsed;

		if ( lane === 'emit' ) {
			const cmd = map.commands.find( ( c ) => c.name === parsed.target );
			if ( !cmd ) return { error: this._notFound( map, raw ) };
			return {
				address: raw, lane, exists: true, shaped: true, argStyle: 'payload',
				desc: cmd.desc, schema: cmd.schema,
				notes: [
					`Crosses ${ cmd.lane }. Fire-and-forget: the bus event returns before the work does, so a step after this one must not read its result on the next line.`,
					'The payload is validated against this schema BEFORE dispatch, so a malformed one comes back `schema-rejected` rather than half-applied.'
				]
			};
		}

		if ( lane === 'bus' ) {
			const served = map.served.find( ( s ) => s.channel === channel );
			if ( !served ) return { error: this._notFound( map, raw ) };
			// `ops: null` is a THIRD answer and must not read as either of the other two: the channel is
			// live and accepts calls, it simply cannot enumerate what it accepts.
			if ( served.ops === null ) {
				return {
					address: raw, lane, exists: true, shaped: false, argStyle: 'positional',
					desc: '', schema: null,
					notes: [ `\`${ channel }\` routes a PARAMETRIC op space and declares no op names, so this address can be neither confirmed nor refused here. It is not a missing declaration — the channel accepts ops it cannot list.` ]
				};
			}
			if ( !served.ops.includes( op! ) ) return { error: this._notFound( map, raw ) };
			return {
				address: raw, lane, exists: true, shaped: false, argStyle: 'positional',
				desc: '', schema: null,
				notes: [
					'BUS VERBS ARE POSITIONAL and their parameter names and order are published nowhere, so `args` must be a LIST in the handler\'s own order. A named object cannot be mapped onto one without inventing an order.',
					`Read \`${ channel }\`'s \`verbs()\` in the service source for what this takes. That this is the only way to find out is a measured gap, not a convention.`
				]
			};
		}

		const pull = map.pulls.find( ( p ) => p.channel === channel );
		if ( !pull ) return { error: this._notFound( map, raw ) };
		const isRead  = pull.reads.includes( op! );
		const isWrite = pull.writes.includes( op! );
		if ( !isRead && !isWrite ) return { error: this._notFound( map, raw ) };

		// THE LANE AND THE OP CLASS MUST AGREE, and disagreeing is worth catching HERE rather than at
		// the door. The door would refuse a write reached through `pull:` correctly — but at run time,
		// mid-sequence, after earlier steps have already mutated the app. Authoring-time is cheaper.
		if ( lane === 'pull' && isWrite ) {
			return { error: `\`${ raw }\` is a declared WRITE reached on the read lane. Address it as \`write:${ channel }.${ op }\` — the door is default-closed to writes and a caller opts in per call, so the opt-in is part of the address rather than a hidden flag.` };
		}
		if ( lane === 'write' && isRead && !isWrite ) {
			return { error: `\`${ raw }\` is a declared READ. Address it as \`pull:${ channel }.${ op }\`. Reaching a read through the write lane is permitted by the door but says the wrong thing in a sequence a person has to review.` };
		}

		return {
			address: raw, lane, exists: true, shaped: false, argStyle: 'object',
			desc: '', schema: null,
			notes: [
				`Pull ops take ONE argument OBJECT, exactly as the renderer sends it.`,
				pull.armed ? '' : `\`${ channel }\` is DECLARED but NOT ARMED in this run — nothing is serving it. That is a fact about this boot, not about the source.`,
				'The pull lane publishes op NAMES only; the argument shape lives in the handler\'s destructuring. Read the service source, and treat that as the gap it is.'
			].filter( Boolean )
		};
	}

	/** "No such address" plus the nearest few that do exist. Cheap, and it turns a dead end into a fix. */
	private _notFound( map: SurfaceMap, raw: string ): string {
		const near = this.addresses( map )
			.map( ( a ) => ( { a, d: distance( a, raw ) } ) )
			.sort( ( x, y ) => x.d - y.d )
			.slice( 0, 5 )
			.filter( ( x ) => x.d <= Math.max( 6, Math.floor( raw.length / 2 ) ) )
			.map( ( x ) => x.a );
		const hint = near.length ? ` Did you mean: ${ near.join( ' · ' ) }?` : '';
		return `\`${ raw }\` is not in the app's declared surface.${ hint } Call describe_surface with no argument for the whole index — it is read off the app's own registries, so it is what the running build actually serves.`;
	}
}();

export type { Address, Lane };

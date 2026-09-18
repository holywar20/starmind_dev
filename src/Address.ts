/**
 * ── THE ADDRESS: `lane:target`, AND THE LANE IS MANDATORY ──────────────────────────────────────
 *
 * `bus:session_store.create` · `pull:session_store.get` · `write:session_store.create` ·
 * `emit:chat_send`
 *
 * ONE STRING, BECAUSE A STEP IS DATA. A sequence has to be authorable as a flat record by something
 * that cannot hold this file in its head, and a three-field discriminated union is harder to write
 * correctly than one address with a visible prefix.
 *
 * THE PREFIX IS REQUIRED, AND THE AUDIT IS WHY. Nine channels appear on BOTH the bus and the pull
 * lane carrying DIFFERENT op sets — `session_store` serves `live` / `set_turn_status` / `autotitle`
 * on the bus and `for_agent` / `transcript_turns` / `compactions` plus fourteen writes on the pull
 * lane. `session_store.create` exists on both and means different things. So a resolver that GUESSED
 * the lane would be right most of the time and silently wrong on the cases that matter most, which is
 * the precise failure this whole surface is built to refuse.
 *
 * `write:` IS ITS OWN LANE RATHER THAN A FLAG on `pull:`. The door is default-closed to writes and a
 * caller opts in per call; making that opt-in a visible part of the address means a step that mutates
 * the app cannot be mistaken for one that reads it while skimming a sequence.
 */
export type Lane = 'bus' | 'pull' | 'write' | 'emit';

export interface Address {
	lane:    Lane;
	/** `channel.op` for bus / pull / write; the bare command name for emit. */
	target:  string;
	/** Set for the three lanes that address a channel; null for `emit`, whose vocabulary is flat. */
	channel: string | null;
	op:      string | null;
}

const LANES: readonly Lane[] = [ 'bus', 'pull', 'write', 'emit' ];

/**
 * Parse one address, or say precisely what is wrong with it.
 *
 * REFUSALS ARE PROSE AND NAME THE FIX, like every other refusal on this surface — an address is
 * written by hand ( or by a model ) far more often than it is generated, so the reader of this
 * message is nearly always one character away from a working step.
 */
export function parseAddress( raw: string ): Address | { error: string } {
	const at = raw.indexOf( ':' );
	if ( at < 0 ) {
		return { error: `"${ raw }" has no lane. Every address is \`lane:target\` — one of ${ LANES.join( ', ' ) }. The lane is required rather than inferred because nine channels serve DIFFERENT ops under the same name on the bus and the pull lane, so a guess would be silently wrong exactly where it matters.` };
	}

	const lane = raw.slice( 0, at ) as Lane;
	const target = raw.slice( at + 1 );
	if ( !LANES.includes( lane ) ) return { error: `"${ lane }" is not a lane. Use one of: ${ LANES.join( ', ' ) }.` };
	if ( !target )                 return { error: `"${ raw }" names a lane and nothing to call.` };

	// EMIT IS FLAT ON PURPOSE — the command vocabulary is a single namespace of 55 names, not
	// channel-and-op. Splitting a dot out of one would invent a structure the registry does not have.
	if ( lane === 'emit' ) return { lane, target, channel: null, op: null };

	const dot = target.lastIndexOf( '.' );
	if ( dot < 0 ) return { error: `"${ target }" is not \`channel.op\`. The ${ lane } lane addresses a channel and an op on it — call describe_surface for what exists.` };
	return { lane, target, channel: target.slice( 0, dot ), op: target.slice( dot + 1 ) };
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Door, describeApp, type AppStamp } from '../Door';

/**
 * WHERE THIS RIG DIALS, and whether it knows that it knows.
 *
 * ── WHY THE PROVENANCE MATTERS AS MUCH AS THE NUMBER ────────────────────────────────────────────
 *
 * `app-down` is the one reply that means NOTHING WAS TESTED, so it is the reply a person acts on — and
 * the action differs entirely depending on where the address came from. A CONFIGURED port that answers
 * nothing means somebody's setting is wrong or the app is down, and the fix is a field on a card. A
 * GUESSED one means we never had an address, and a reader sent looking for a setting that was never set
 * loses the pass. So `configured()` is not a detail of `candidates()`; it is half the diagnosis.
 *
 * ── THE TWO ROADS ───────────────────────────────────────────────────────────────────────────────
 *
 * Spawned by Starmind, the manifest declares `STARMIND_DEV_PORT` with a default, so the variable is
 * always present and the walk stops at one port. Spawned standalone — `npm start`, or a plain `claude`
 * session through the repo's `.mcp.json` — nothing injects it and the probe is the only way to find the
 * app. Both are live, and the tests below are the two of them.
 */
describe( 'Door — the address, and where it came from', () => {

	const ENV = 'STARMIND_DEV_PORT';
	let held: string | undefined;

	beforeEach( () => { held = process.env[ ENV ]; delete process.env[ ENV ]; } );
	afterEach( () => { if ( held === undefined ) delete process.env[ ENV ]; else process.env[ ENV ] = held; } );

	it( 'takes a configured port as the WHOLE answer — nothing is probed', () => {
		process.env[ ENV ] = '4242';
		expect( Door.configured() ).toBe( 4242 );
		expect( Door.candidates() ).toEqual( [ 4242 ] );
	} );

	it( 'says it is UNCONFIGURED when nothing set one, and guesses both arrangements', () => {
		expect( Door.configured() ).toBeNull();
		// The two ports this rig has ever used. The second survives only for a shell or checkout predating
		// the 2026-09-04 change; finding one costs a connect against a closed socket, missing it costs a pass.
		expect( Door.candidates() ).toEqual( [ 51789, 51790 ] );
	} );

	it( 'treats a BAD port as unconfigured rather than dialling it', () => {
		// A typo must cost the fixed address, not the whole road — the same reading `DevLane.endpoint` makes
		// of a bad port on the app's side. Dialling 0, or NaN, would turn one wrong character into
		// "the app is down".
		for ( const bad of [ 'abc', '0', '-1', '70000', '', '51789.5' ] ) {
			process.env[ ENV ] = bad;
			expect( Door.configured(), `"${ bad }" should not configure a port` ).toBeNull();
			expect( Door.candidates() ).toEqual( [ 51789, 51790 ] );
		}
	} );

	it( 'accepts the edges of the legal range', () => {
		for ( const ok of [ '1', '65535' ] ) {
			process.env[ ENV ] = ok;
			expect( Door.configured() ).toBe( Number( ok ) );
		}
	} );
} );

/**
 * WHICH APP ANSWERED — the line every hot reply carries.
 *
 * ── THE FAILURE IT EXISTS TO PREVENT ────────────────────────────────────────────────────────────
 *
 * Only an UNPACKAGED Starmind opens the dev door. So on a machine running two copies, an agent hosted by
 * the packaged one reads and drives the OTHER app through this rig — a `read_state` returns real trace
 * lines about a process the asker is not in. Nothing goes wrong; the answer is simply about somewhere
 * else, and that is far harder to notice than an error.
 *
 * So the test worth having is not "does it parse a header". It is that a reader who quotes a reply cannot
 * avoid quoting which app it came from, INCLUDING when no app has answered at all — the case where a
 * confident-sounding line would be an invention.
 */
describe( 'describeApp — naming the process behind an answer', () => {

	const stamp = ( over: Partial<AppStamp> = {} ): AppStamp =>
		( { pid: 1234, port: 51789, packaged: false, uptimeMs: 90_000, ...over } );

	it( 'names the pid AND the port, because neither alone identifies a process', () => {
		// A port is reused across a restart and a pid says nothing about which door it opened. Quoting one
		// without the other is how two runs of an experiment get attributed to one app.
		const line = describeApp( stamp() );
		expect( line ).toContain( '1234' );
		expect( line ).toContain( '51789' );
	} );

	it( 'says PACKAGED loudly, because that is the copy that should not be answering', () => {
		expect( describeApp( stamp( { packaged: true } ) ) ).toContain( 'PACKAGED' );
		expect( describeApp( stamp( { packaged: false } ) ) ).toContain( 'unpackaged' );
	} );

	it( 'warns that this is not necessarily the app hosting the reader', () => {
		// The whole point. A reply that named a pid and stopped there would read as "your app", which is the
		// belief this arrangement quietly breaks.
		expect( describeApp( stamp() ) ).toContain( 'NOT necessarily the one hosting you' );
	} );

	it( 'claims NOTHING when no app has answered yet', () => {
		// Absence has to read as absence. A default pid, or a cheerful "unknown app", would both be claims
		// about a process nobody has heard from.
		const line = describeApp( null );
		expect( line ).toContain( 'No app has answered' );
		expect( line ).not.toMatch( /\d/ );
	} );
} );

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { bootNotePath, explain, readNote, readNotes, type BootNote, type NoteRead } from '../BootNote';
import type { AppStamp } from '../Door';

/**
 * TELLING THE SEVEN STATES APART — the whole deliverable, and provable with NO APP RUNNING.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 *
 * `app-down` stood for at least seven distinct situations, each with a different fix, and this side
 * could distinguish none of them. Every reply named five possible causes and confirmed no cause at all,
 * so the agent reading it picked the likeliest — usually "the app is dead" — and escalated with a wrong
 * diagnosis attached. DEFECT-137 papered over it by naming the supervisor log; this closes it.
 *
 * ── WHY THE TESTS ARE AGAINST `explain` AND NOT AGAINST A LIVE APP ──────────────────────────────
 *
 * The situations being told apart are exactly the ones in which nothing answers. A suite that needed an
 * app up could not reach a single one of them. `explain` is pure — no disk, no clock, no socket — so the
 * whole matrix is reachable, and `readNote` is tested separately against real files in a temp folder
 * because its job is the I/O the pure half refuses to do.
 *
 * ── THE PROPERTY UNDERNEATH ALL SEVEN ───────────────────────────────────────────────────────────
 *
 * Never claim the app is up. Not even when the note says the door opened — a note records a past boot,
 * and trading one confident wrong answer for another is the failure this exists to end. Every branch
 * that reads a note is checked for that sentence.
 */

const NOTE: BootNote = {
	at:         '2026-09-30T12:00:00.000Z',
	pid:        4242,
	packaged:   false,
	door:       'open',
	why:        '',
	fix:        '',
	wantedPort: 51789,
	boundPort:  51789,
	tokenSet:   true
};

const NOW = Date.parse( '2026-09-30T12:05:00.000Z' );

/** One read note, at the path the app would have written it to. */
function read( over: Partial<BootNote> = {} ): NoteRead {
	const note = { ...NOTE, ...over };
	return { state: 'read', path: bootNotePath( note.wantedPort > 0 ? note.wantedPort : 'ephemeral', '/x' ), note };
}

const absent = ( key: number | 'ephemeral' ): NoteRead => ( { state: 'absent', path: bootNotePath( key, '/x' ) } );

const stamp = ( over: Partial<AppStamp> = {} ): AppStamp =>
	( { pid: 4242, port: 51789, packaged: false, uptimeMs: 9000, ...over } );

describe( 'explain — one cause, named', () => {

	// ── 1. THE APP IS NOT RUNNING ───────────────────────────────────────────────────────────────

	it( 'reads an ABSENT note as a finding, not as an error', () => {
		// A missing note means no dev session ever booted here, which is useful and different from a
		// broken one. It also cannot be certain: an app built before the note existed writes none either.
		const out = explain( [ 51789 ], [ absent( 51789 ), absent( 'ephemeral' ) ], null, NOW );
		expect( out.cause ).toContain( 'NO BOOT NOTE' );
		expect( out.cause ).toContain( 'the app is not running' );
		expect( out.cause ).toContain( 'finding rather than an error' );
		expect( out.certain ).toBe( false );
	} );

	it( 'names both paths it looked at, so the reader can check the claim', () => {
		const out = explain( [ 51789 ], [ absent( 51789 ), absent( 'ephemeral' ) ], null, NOW );
		expect( out.cause ).toContain( '.dev-boot-51789.json' );
		expect( out.cause ).toContain( '.dev-boot-ephemeral.json' );
	} );

	// ── 2–5. THE DOOR IS SHUT, IN FOUR DIFFERENT WAYS ───────────────────────────────────────────
	//
	// One branch here and four sentences, because the app's own `why` rides across verbatim. That is the
	// design: a code would have to be re-expanded out here, and the expansion is a second copy of a
	// sentence that is already better written on the other side.

	it( 'quotes the switch UNSET verbatim, and its fix', () => {
		const out = explain( [ 51789 ], [ read( {
			door: 'shut', why: 'the dev door is shut — no switch set', fix: 'Set STARMIND_DEV_DOOR=YYYY-MM-DD.'
		} ) ], null, NOW );
		expect( out.cause ).toContain( 'DEV DOOR IS SHUT' );
		expect( out.cause ).toContain( 'the dev door is shut — no switch set' );
		expect( out.cause ).toContain( 'Set STARMIND_DEV_DOOR=YYYY-MM-DD.' );
		expect( out.certain ).toBe( true );
	} );

	it( 'quotes a MALFORMED switch, including the value that was refused', () => {
		const out = explain( [ 51789 ], [ read( {
			door: 'shut', why: 'the switch is not a YYYY-MM-DD date: "today"', fix: 'x'
		} ) ], null, NOW );
		expect( out.cause ).toContain( 'not a YYYY-MM-DD date: "today"' );
	} );

	it( 'quotes an EXPIRED switch with its date', () => {
		const out = explain( [ 51789 ], [ read( {
			door: 'shut', why: 'the switch expired on 2026-09-22', fix: 'x'
		} ) ], null, NOW );
		expect( out.cause ).toContain( 'the switch expired on 2026-09-22' );
	} );

	it( 'quotes a switch BEYOND THE WINDOW, which is the opposite mistake to an expired one', () => {
		const out = explain( [ 51789 ], [ read( {
			door: 'shut', why: 'the switch is dated 2099-01-01, 26000 days ahead — beyond the 7-day window.', fix: 'x'
		} ) ], null, NOW );
		expect( out.cause ).toContain( 'beyond the 7-day window' );
		expect( out.cause ).not.toContain( 'expired' );
	} );

	// ── 6. AN EPHEMERAL OR MOVED PORT ───────────────────────────────────────────────────────────

	it( 'names an EPHEMERAL port as unreachable by any fixed address, and says what to set', () => {
		const out = explain( [ 51789 ], [ read( { wantedPort: 0, boundPort: 54321 } ) ], null, NOW );
		expect( out.cause ).toContain( 'EPHEMERAL PORT' );
		expect( out.cause ).toContain( 'STARMIND_ROUTER_PORT=51789' );
		expect( out.certain ).toBe( true );
	} );

	it( 'names a fixed port that FELL BACK, and the second copy that most likely took it', () => {
		const out = explain( [ 51789 ], [ read( { wantedPort: 51789, boundPort: 54321 } ) ], null, NOW );
		expect( out.cause ).toContain( 'FELL BACK' );
		expect( out.cause ).toContain( 'asked for 51789 and bound 54321' );
		expect( out.cause ).toContain( 'SECOND' );
	} );

	it( 'names a port the rig simply did not dial, and points at this side\'s setting', () => {
		const out = explain( [ 51789 ], [ read( { wantedPort: 51999, boundPort: 51999 } ) ], null, NOW );
		expect( out.cause ).toContain( 'DISAGREE ABOUT THE PORT' );
		expect( out.cause ).toContain( 'STARMIND_DEV_PORT to 51999' );
	} );

	it( 'names a router that never bound at all, which is not the same as a shut door', () => {
		const out = explain( [ 51789 ], [ read( { boundPort: 0 } ) ], null, NOW );
		expect( out.cause ).toContain( 'NEVER BOUND A PORT' );
		expect( out.cause ).toContain( 'WARNINGS' );
	} );

	// ── 7. A STALE NOTE ─────────────────────────────────────────────────────────────────────────

	it( 'reports a note from a DIFFERENT PID as stale, and refuses to read its door state', () => {
		// The one handle on staleness available from out here. A note about another boot cannot answer a
		// question about this one, and reading past it would answer confidently about the wrong process.
		const out = explain( [ 51789 ], [ read( { door: 'shut', why: 'the switch expired on 2026-09-22' } ) ],
			stamp( { pid: 9999 } ), NOW );
		expect( out.cause ).toContain( 'STALE' );
		expect( out.cause ).toContain( 'pid 4242' );
		expect( out.cause ).toContain( 'pid 9999' );
		// And it must not have gone on to quote a door state it has just called unreliable.
		expect( out.cause ).not.toContain( 'expired on 2026-09-22' );
	} );

	it( 'does not call a note stale when the pid matches the app that answered', () => {
		const out = explain( [ 51789 ], [ read( { door: 'shut', why: 'no switch set', fix: 'x' } ) ], stamp(), NOW );
		expect( out.cause ).not.toContain( 'STALE' );
	} );

	// ── NEVER CLAIM THE APP IS UP ───────────────────────────────────────────────────────────────

	it( 'states BOTH facts when the note says open and nothing answers', () => {
		// The temptation this test exists to refuse: the note is the only evidence, it says the door
		// opened, and asserting that the app is therefore up would be a new confident wrong answer.
		const out = explain( [ 51789 ], [ read() ], null, NOW );
		expect( out.cause ).toContain( 'DISAGREE' );
		expect( out.cause ).toContain( 'nothing answers that port now' );
		expect( out.cause ).not.toContain( 'the app is up' );
		expect( out.cause ).toContain( 'nothing here claims it is' );
	} );

	it( 'carries the not-now caveat on EVERY cause derived from a note', () => {
		const cases: NoteRead[][] = [
			[ read() ],
			[ read( { door: 'shut', why: 'no switch set', fix: 'x' } ) ],
			[ read( { wantedPort: 0, boundPort: 54321 } ) ],
			[ read( { wantedPort: 51789, boundPort: 54321 } ) ],
			[ read( { wantedPort: 51999, boundPort: 51999 } ) ],
			[ read( { boundPort: 0 } ) ]
		];
		for ( const reads of cases ) {
			const out = explain( [ 51789 ], reads, null, NOW );
			expect( out.cause, out.cause ).toContain( 'It does not say whether the app is running now' );
		}
	} );

	it( 'says how old the note is, because the same sentence means different things at 5 minutes and 9 days', () => {
		expect( explain( [ 51789 ], [ read() ], null, NOW ).cause ).toContain( '5 minute' );
		const old = Date.parse( '2026-10-09T12:00:00.000Z' );
		expect( explain( [ 51789 ], [ read() ], null, old ).cause ).toContain( '9 day' );
	} );

	// ── DEGRADE, NEVER THROW ────────────────────────────────────────────────────────────────────

	it( 'falls back to the older five-cause answer when the note cannot be parsed', () => {
		const out = explain( [ 51789 ], [ { state: 'unreadable', path: '/x/.dev-boot-51789.json', why: 'the note is not JSON' } ], null, NOW );
		expect( out.cause ).toContain( 'COULD NOT BE READ' );
		expect( out.cause ).toContain( 'not a finding about the app' );
		// `certain: false` is what puts the old paragraph back on the reply.
		expect( out.certain ).toBe( false );
	} );

	it( 'prefers a note it could read over one it could not', () => {
		const out = explain( [ 51789 ],
			[ { state: 'unreadable', path: '/x/a.json', why: 'the note is not JSON' }, read( { door: 'shut', why: 'no switch set', fix: 'x' } ) ],
			null, NOW );
		expect( out.certain ).toBe( true );
		expect( out.cause ).toContain( 'no switch set' );
	} );
} );

describe( 'readNote — the I/O half', () => {

	let dir: string;

	function withDir( run: ( d: string ) => void ): void {
		dir = mkdtempSync( join( tmpdir(), 'bootnote-' ) );
		try { run( dir ); } finally { rmSync( dir, { recursive: true, force: true } ); }
	}

	it( 'reads a note the app wrote, and keeps ABSENT distinct from UNREADABLE', () => {
		withDir( ( d ) => {
			writeFileSync( bootNotePath( 51789, d ), JSON.stringify( NOTE ), 'utf8' );
			writeFileSync( bootNotePath( 'ephemeral', d ), 'not json at all', 'utf8' );

			const good = readNote( 51789, d );
			expect( good.state ).toBe( 'read' );
			expect( good.state === 'read' && good.note.boundPort ).toBe( 51789 );

			expect( readNote( 4242, d ).state ).toBe( 'absent' );
			expect( readNote( 'ephemeral', d ).state ).toBe( 'unreadable' );
		} );
	} );

	it( 'treats JSON that is not a boot note as unreadable rather than as a note of zeroes', () => {
		// A shape assumed is a shape that throws on the day it changes, and a note of zeroes would be read
		// as "the router never bound", which is a real diagnosis this must not invent.
		withDir( ( d ) => {
			writeFileSync( bootNotePath( 51789, d ), JSON.stringify( { hello: 'world' } ), 'utf8' );
			expect( readNote( 51789, d ).state ).toBe( 'unreadable' );
		} );
	} );

	it( 'looks for the EPHEMERAL note as well as the ports dialled', () => {
		// The state no fixed address can find is precisely the one worth finding. Not looking for it would
		// leave it undiagnosable forever.
		withDir( ( d ) => {
			writeFileSync( bootNotePath( 'ephemeral', d ), JSON.stringify( { ...NOTE, wantedPort: 0, boundPort: 54321 } ), 'utf8' );
			const reads = readNotes( [ 51789 ], d );
			expect( reads.map( ( r ) => r.state ) ).toEqual( [ 'absent', 'read' ] );
		} );
	} );

	it( 'never throws on a path that is not a file', () => {
		withDir( ( d ) => {
			expect( () => readNote( 51789, join( d, 'nowhere' ) ) ).not.toThrow();
			expect( readNote( 51789, join( d, 'nowhere' ) ).state ).toBe( 'absent' );
		} );
	} );
} );

/**
 * THE INVARIANT NOBODY WOULD NOTICE BREAKING — a successful reply must carry no door state.
 *
 * Report errors, not status. A reply that worked has already proved everything the note could say, and a
 * second authority on that question is one that can disagree with the first — with the reassuring one
 * always the one somebody believes. The pressure here is real and friendly: the next person to add a
 * helpful "( door open, port 51789 )" to a success line will not think they are breaking anything.
 *
 * Asserted against the SOURCE rather than against a reply, because the property is "this is read on one
 * path only" and no single reply can demonstrate that.
 */
describe( 'the note is read on the failure path and nowhere else', () => {

	const src = ( file: string ): string => readFileSync( join( __dirname, '..', file ), 'utf8' );

	it( 'is consulted from exactly ONE place in Door, and that place is the app-down assembly', () => {
		const door  = src( 'Door.ts' );
		const calls = door.split( 'diagnose(' ).length - 1;
		expect( calls, 'diagnose() should be called once, from _appDown' ).toBe( 1 );
		// And the one call sits inside `_appDown` — the method every app-down reply goes through.
		const body = door.slice( door.indexOf( 'private _appDown' ), door.indexOf( 'private _noteApp' ) );
		expect( body ).toContain( 'diagnose(' );
	} );

	it( 'is not reached by any tool module, which is where a status field would be added', () => {
		for ( const file of [ 'tools/hot.ts', 'tools/drive.ts', 'tools/fluent.ts', 'tools/testbed.ts', 'Steps.ts' ] ) {
			expect( src( file ), `${ file } should not read the boot note` ).not.toContain( 'BootNote' );
		}
	} );

	it( 'adds no status verb — the roster does not grow for this', () => {
		// `dev_status` already exists and is the honest shape of the question: it proves the app is up by
		// working. A sibling that reports on-ness as data is the thing this task refuses to build.
		const hot = src( 'tools/hot.ts' );
		for ( const banned of [ 'door_status', 'boot_note', 'dev_health' ] ) {
			expect( hot ).not.toContain( banned );
		}
	} );
} );

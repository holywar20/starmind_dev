import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { exitNotePath, explainExit, readExitNote, type DevExitNote, type ExitNoteRead } from '../ExitNote';

/**
 * THE DEATH NOTE, READ — the half of the forensic record `app-down` never looked at before TASK-305.
 *
 * ── THE WORKED EXAMPLE THIS SUITE IS BUILT AROUND ──────────────────────────────────────────────
 *
 * The exact note left on disk by a real session the card was written against:
 *
 *   { "at": "2026-10-13T17:19:51.890Z", "pid": 33992, "uptimeMs": 2433365,
 *     "reason": "window-all-closed", "windows": 0, "restart": false }
 *
 * — booted, ran forty minutes, and a person closed the last window. `BOOT_AT` below is set so the boot
 * note this pairs against sits exactly `uptimeMs` earlier, the same relationship a real boot/exit pair
 * always has.
 *
 * ── WHY `explainExit` IS TESTED PURE, AS `BootNote.explain` IS ─────────────────────────────────
 *
 * No disk, no app, no clock dependency beyond the `now` argument — the whole branch matrix is reachable
 * with nothing running, which is also the one condition this card had to be provable under.
 */

const EXIT: DevExitNote = {
	at:       '2026-10-13T17:19:51.890Z',
	pid:      33992,
	uptimeMs: 2_433_365,
	reason:   'window-all-closed',
	windows:  0,
	restart:  false
};

const BOOT_AT = new Date( Date.parse( EXIT.at ) - EXIT.uptimeMs ).toISOString();
const NOW     = Date.parse( '2026-10-13T17:25:00.000Z' );

const read = ( over: Partial<DevExitNote> = {} ): ExitNoteRead =>
	( { state: 'read', path: exitNotePath( 51789, '/x' ), note: { ...EXIT, ...over } } );

const absent = (): ExitNoteRead => ( { state: 'absent', path: exitNotePath( 51789, '/x' ) } );

describe( 'explainExit — one lead sentence, from whatever evidence there is', () => {

	// ── NOTHING TO SAY AT ALL ───────────────────────────────────────────────────────────────────

	it( 'says nothing when there is no boot note to pair against', () => {
		// No boot note means nothing in this reply is about a specific boot, so there is no sibling to
		// check for an exit note against — the existing checklist is the whole answer, unchanged.
		expect( explainExit( null, read(), NOW ) ).toBeNull();
	} );

	// ── 1. THE CLEAN QUIT — THE WORKED EXAMPLE ──────────────────────────────────────────────────

	it( 'leads with a clean quit: booted, ran the stated duration, closed by a person', () => {
		const out = explainExit( BOOT_AT, read(), NOW );
		expect( out?.certain ).toBe( true );
		expect( out?.lead ).toContain( 'QUIT CLEANLY' );
		expect( out?.lead ).toContain( '41 MINUTE' );
		expect( out?.lead ).toContain( EXIT.at );
		expect( out?.lead ).toContain( 'start it again' );
		// AND IT MUST SAY NOTHING CRASHED — the sentence this card exists to stop a reader inventing.
		expect( out?.lead ).toContain( 'Nothing crashed' );
	} );

	// ── 2. A RESTART IN PROGRESS — A WAIT, NOT A FAULT ──────────────────────────────────────────

	it( 'reports a staged restart as a WAIT rather than a fault, whatever the reason says', () => {
		const out = explainExit( BOOT_AT, read( { reason: 'will-quit', restart: true } ), NOW );
		expect( out?.lead ).toContain( 'RESTARTING' );
		expect( out?.lead ).toContain( 'WAIT, not a fault' );
		expect( out?.lead ).not.toContain( 'app.quit() FOR AN UNATTRIBUTED REASON' );
	} );

	// ── 3. AN UNATTRIBUTED QUIT, NO RESTART STAGED ──────────────────────────────────────────────

	it( 'names an unattributed app.quit() distinctly from both a clean quit and a restart', () => {
		const out = explainExit( BOOT_AT, read( { reason: 'will-quit', restart: false } ), NOW );
		expect( out?.lead ).toContain( 'UNATTRIBUTED REASON' );
		expect( out?.lead ).not.toContain( 'RESTARTING' );
		expect( out?.lead ).not.toContain( 'QUIT CLEANLY' );
	} );

	// ── 4. A BOOT FAILURE — A CRASH, NAMED AS ONE ────────────────────────────────────────────────

	it( 'names a boot failure as a crash, and points at the trace and the supervisor log', () => {
		const out = explainExit( BOOT_AT, read( { reason: 'boot-failed', uptimeMs: 1800 } ), NOW );
		expect( out?.lead ).toContain( 'CRASH' );
		expect( out?.lead ).toContain( 'WARNINGS' );
		// A SHORT uptime wants a different sentence than a forty-minute run, and it is: the stated duration
		// itself carries that difference rather than a separate threshold.
		expect( out?.lead ).toContain( '2 second' );
	} );

	// ── 5. NO EXIT NOTE BESIDE A BOOT NOTE — A KILL OR AN UNHANDLED DEATH, NEVER A DEFAULT ──────

	it( 'reports an ABSENT exit note beside a real boot note as a kill or unhandled death', () => {
		const out = explainExit( BOOT_AT, absent(), NOW );
		expect( out?.certain ).toBe( true );
		expect( out?.lead ).toContain( 'KILLED or DIED UNHANDLED' );
		expect( out?.lead ).not.toContain( 'QUIT CLEANLY' );
		expect( out?.lead ).not.toContain( 'RESTARTING' );
	} );

	it( 'treats a STALE exit note — older than the boot it is paired against — the same as absent', () => {
		// `DevLane.writeNote` deletes the previous exit note at every fresh boot, so this should not arise
		// in practice; it is still handled rather than trusted, because a reader out here checks everything.
		const stale = read( { at: new Date( Date.parse( BOOT_AT ) - 60_000 ).toISOString() } );
		const out = explainExit( BOOT_AT, stale, NOW );
		expect( out?.lead ).toContain( 'KILLED or DIED UNHANDLED' );
	} );

	// ── 6. A MALFORMED NOTE — A FAULT IN THE INSTRUMENT, NOT A FINDING ABOUT THE APP ────────────

	it( 'names an unreadable exit note as an instrument fault, and states nothing about the app', () => {
		const out = explainExit( BOOT_AT,
			{ state: 'unreadable', path: '/x/.dev-exit-51789.json', why: 'the note is not JSON' }, NOW );
		expect( out?.certain ).toBe( false );
		expect( out?.lead ).toContain( 'COULD NOT BE READ' );
		expect( out?.lead ).not.toContain( 'KILLED' );
		expect( out?.lead ).not.toContain( 'QUIT CLEANLY' );
	} );
} );

describe( 'readExitNote — the I/O half', () => {

	let dir: string;

	function withDir( run: ( d: string ) => void ): void {
		dir = mkdtempSync( join( tmpdir(), 'exitnote-' ) );
		try { run( dir ); } finally { rmSync( dir, { recursive: true, force: true } ); }
	}

	it( 'reads a note the app wrote, keeping ABSENT distinct from UNREADABLE', () => {
		withDir( ( d ) => {
			writeFileSync( exitNotePath( 51789, d ), JSON.stringify( EXIT ), 'utf8' );
			writeFileSync( exitNotePath( 'ephemeral', d ), 'not json at all', 'utf8' );

			const good = readExitNote( 51789, d );
			expect( good.state ).toBe( 'read' );
			expect( good.state === 'read' && good.note.reason ).toBe( 'window-all-closed' );

			expect( readExitNote( 4242, d ).state ).toBe( 'absent' );
			expect( readExitNote( 'ephemeral', d ).state ).toBe( 'unreadable' );
		} );
	} );

	it( 'treats JSON that is not an exit note as unreadable, not as a note of defaults', () => {
		withDir( ( d ) => {
			writeFileSync( exitNotePath( 51789, d ), JSON.stringify( { hello: 'world' } ), 'utf8' );
			expect( readExitNote( 51789, d ).state ).toBe( 'unreadable' );
		} );
	} );

	it( 'treats an unknown `reason` as unreadable rather than silently accepting it', () => {
		withDir( ( d ) => {
			writeFileSync( exitNotePath( 51789, d ), JSON.stringify( { ...EXIT, reason: 'sigkill' } ), 'utf8' );
			const out = readExitNote( 51789, d );
			expect( out.state ).toBe( 'unreadable' );
			expect( out.state === 'unreadable' && out.why ).toContain( 'sigkill' );
		} );
	} );

	it( 'never throws on a path that is not a file', () => {
		withDir( ( d ) => {
			expect( () => readExitNote( 51789, join( d, 'nowhere' ) ) ).not.toThrow();
			expect( readExitNote( 51789, join( d, 'nowhere' ) ).state ).toBe( 'absent' );
		} );
	} );
} );

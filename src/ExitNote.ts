import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE DEATH NOTE, READ FROM OUT HERE — the boot note's twin, and the other half of the forensic record
 * `app-down` can read with no app running ( TASK-305 ).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * `DevLane.writeExitNote` ( `starmind/src/main/services/DevLane.ts` ) writes this at the DECISION to
 * quit, before the quit happens — so even a clean exit, which the supervisor only ever sees as code 0,
 * leaves a reason behind. A literal search for `dev-exit` across the whole workspace found exactly the
 * one write and no reader anywhere: the rig had `BootNote.ts` and its suite, and nothing beside it.
 *
 * ── ABSENCE STAYS MEANINGFUL ────────────────────────────────────────────────────────────────────
 *
 * `DevLane`'s own comment is explicit: *"Written only on decided paths: a signalled process runs no
 * handler and leaves no note, and that absence is the signal."* This is read only inside `app-down`,
 * where nothing answers the port — so a boot note with NO exit note beside it, in that one context,
 * means the app was killed or died unhandled. That is a real and different finding from a clean quit,
 * and `explainExit` says so rather than inventing a default for it.
 *
 * ── SAME SHAPE, SAME KEYING, A SEPARATE FILE ────────────────────────────────────────────────────
 *
 * This mirrors `BootNote.ts` on purpose rather than extending it: a `NoteRead`-shaped union, a
 * re-validated interface ( this is a file written by ANOTHER PROCESS — a shape assumed is a shape that
 * throws the day it changes ), and the same `number | 'ephemeral'` key `DevLane.exitNotePath` uses — the
 * port the app ASKED for, not the one it got, exactly as the boot note keys.
 */

/** The record the app writes at the decision to quit. Every field is re-checked on read, as `BootNote`'s own. */
export interface DevExitNote {
	at:       string;
	pid:      number;
	uptimeMs: number;
	reason:   'window-all-closed' | 'boot-failed' | 'will-quit';
	windows:  number;
	restart:  boolean;
}

/** Three states, not two — `absent` is a finding ( no decided quit left a note ) and `unreadable` is a
 *  fault in the instrument. Folding them together would let a corrupted note read as a clean absence. */
export type ExitNoteRead =
	| { state: 'absent';     path: string }
	| { state: 'unreadable'; path: string; why: string }
	| { state: 'read';       path: string; note: DevExitNote };

/** Beside the boot note, keyed the same way — `DevLane.exitNotePath`'s own naming. */
export function exitNotePath( key: number | 'ephemeral', dir: string ): string {
	return join( dir, `.dev-exit-${ key }.json` );
}

/** Read one. NEVER THROWS, for the reason `readNote` in `BootNote.ts` never does. */
export function readExitNote( key: number | 'ephemeral', dir: string ): ExitNoteRead {
	const path = exitNotePath( key, dir );
	let text: string;
	try { text = readFileSync( path, 'utf8' ); }
	catch ( err ) {
		const code = ( err as NodeJS.ErrnoException ).code;
		return code === 'ENOENT' ? { state: 'absent', path } : { state: 'unreadable', path, why: code ?? String( err ) };
	}
	try {
		const raw = JSON.parse( text ) as Partial<DevExitNote>;
		if ( typeof raw.at !== 'string' ) return { state: 'unreadable', path, why: 'the note is JSON but not an exit note' };
		if ( raw.reason !== 'window-all-closed' && raw.reason !== 'boot-failed' && raw.reason !== 'will-quit' ) {
			return { state: 'unreadable', path, why: `the note names an unknown reason "${ String( raw.reason ) }"` };
		}
		return { state: 'read', path, note: {
			at:       raw.at,
			pid:      typeof raw.pid === 'number' ? raw.pid : 0,
			uptimeMs: typeof raw.uptimeMs === 'number' ? raw.uptimeMs : 0,
			reason:   raw.reason,
			windows:  typeof raw.windows === 'number' ? raw.windows : 0,
			restart:  raw.restart === true
		} };
	} catch {
		return { state: 'unreadable', path, why: 'the note is not JSON' };
	}
}

/** How long a run lasted, in words — the same scale `BootNote`'s own `ago()` uses, so the two read
 *  alike sitting beside each other in one reply. */
function duration( ms: number ): string {
	const secs = Math.max( 0, Math.round( ms / 1000 ) );
	if ( secs < 60 )   return `${ secs } second(s)`;
	const mins = Math.round( secs / 60 );
	if ( mins < 60 )   return `${ mins } minute(s)`;
	return `${ Math.round( mins / 60 ) } hour(s)`;
}

/** How long ago the decision was made, against the clock — `BootNote.ago`'s own shape, kept local
 *  because that one is not exported and duplicating four lines beats importing a private helper. */
function since( at: string, now: number ): string {
	const then = Date.parse( at );
	if ( Number.isNaN( then ) ) return `timestamped "${ at }", which is not a readable date`;
	const mins = Math.round( ( now - then ) / 60_000 );
	if ( mins < 1 )    return 'less than a minute ago';
	if ( mins < 60 )   return `${ mins } minute(s) ago`;
	if ( mins < 1440 ) return `${ Math.round( mins / 60 ) } hour(s) ago`;
	return `${ Math.round( mins / 1440 ) } day(s) ago`;
}

/**
 * THE LEADING SENTENCE, when there is one to say — `null` when the exit note has nothing to add to the
 * `app-down` reply, which is the case whenever there is no sibling boot note to pair it against. Pure,
 * like `BootNote.explain`: provable with no disk and no app.
 *
 * `bootAt` is the sibling boot note's OWN timestamp. A death note older than it is from an earlier boot —
 * `DevLane.writeNote` deletes the previous exit note at every fresh boot, so this should not happen in
 * practice, but a reader out here trusts nothing it did not just check.
 *
 * ── THE ORDER OF THE BRANCHES IS THE DIAGNOSIS, AS IN `explain` ───────────────────────────────────
 * `restart` is asked before `reason`, because a restart in progress is a WAIT and every `reason` it can
 * ride beside would otherwise be read as a fault.
 */
export function explainExit( bootAt: string | null, read: ExitNoteRead, now: number ): { lead: string; certain: boolean } | null {
	if ( bootAt === null ) return null;

	if ( read.state === 'unreadable' ) {
		return { certain: false, lead:
			`A DEATH NOTE IS THERE AND COULD NOT BE READ: \`${ read.path }\` ( ${ read.why } ). That is a fault ` +
			'in the instrument rather than a finding about the app, so the exit reason below is not stated.' };
	}

	if ( read.state === 'absent' || Date.parse( read.note.at ) < Date.parse( bootAt ) ) {
		return { certain: true, lead:
			'THE APP BOOTED AND LEFT NO DEATH NOTE FOR THAT BOOT. A note is written only on a DECIDED quit — ' +
			'a clean exit, a boot failure, or `app.quit()` — and a signalled process runs no handler and ' +
			'leaves none. No exit note beside the boot note means the app was KILLED or DIED UNHANDLED, not ' +
			'that it quit cleanly. Check the supervisor log below for the exit code.' };
	}

	const note = read.note;
	const ranFor = duration( note.uptimeMs );
	const whenAgo = since( note.at, now );

	if ( note.restart ) {
		return { certain: true, lead:
			`THE APP IS RESTARTING. It booted, ran ${ ranFor }, and decided to quit ${ whenAgo } ( at ${ note.at } ` +
			'), with a restart already staged. This is a WAIT, not a fault — ask again in a few seconds.' };
	}

	if ( note.reason === 'window-all-closed' ) {
		return { certain: true, lead:
			`THE APP BOOTED, RAN ${ ranFor.toUpperCase() }, AND QUIT CLEANLY ${ whenAgo.toUpperCase() } — the last ` +
			`window closed at ${ note.at }, leaving ${ note.windows } window(s) open. Nothing crashed and ` +
			'nothing is wedged. The remedy is to start it again, not to adjust any setting.' };
	}

	if ( note.reason === 'boot-failed' ) {
		return { certain: true, lead:
			`THE APP BOOTED AND A CRITICAL BOOT STEP THREW, ${ ranFor } in, ${ whenAgo } ( at ${ note.at } ). This ` +
			'is a CRASH, not a configuration state — look on the WARNINGS trace channel and the supervisor ' +
			'log below for what threw.' };
	}

	// `will-quit`, no restart staged — `app.quit()` from a site this note cannot name.
	return { certain: true, lead:
		`THE APP BOOTED, RAN ${ ranFor }, AND CALLED app.quit() FOR AN UNATTRIBUTED REASON ${ whenAgo } ( at ` +
		`${ note.at } ), with no restart staged. Check the supervisor log below for what asked it to quit.` };
}

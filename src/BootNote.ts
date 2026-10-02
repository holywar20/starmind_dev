import { readFileSync } from 'fs';
import { join } from 'path';

import type { AppStamp } from './Door';
import { Workspace } from './Workspace';

/**
 * THE BOOT NOTE, READ FROM OUT HERE — the app's own account of what it did with the dev lane.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * `app-down` stood for seven different states and this side could distinguish none of them, so every
 * reply named five possible causes and confirmed no cause at all. The agent reading it picked the
 * likeliest — usually "the app is dead" — and escalated with a wrong diagnosis attached.
 *
 * The diagnosis already existed. `DevLane._switch()` computes four exact refusals, and not one of them
 * could ever reach a caller, because reaching the app to ask is precisely what a shut door prevents. So
 * the app now writes them down on its own side of the wall, and this reads them. No door needed.
 *
 * ── IT IS READ ONLY WHEN SOMETHING REFUSED ──────────────────────────────────────────────────────
 *
 * Report errors, not status ( Bryan, 2026-09-30 ). A call that works has already proved everything this
 * file could say, so no success path reads it, no reply carries door state, and there is no verb that
 * reports on-ness. `dev_status` is the honest shape of that question and it answers it by working.
 *
 * ── IT POINTS, IT DOES NOT ADJUDICATE ───────────────────────────────────────────────────────────
 *
 * A note is evidence about a PAST BOOT. It cannot say whether the app is running now, and nothing here
 * pretends otherwise — including when the note says the door opened. Trading one confident wrong answer
 * for another is the defect this replaces, so where the note and the silent socket disagree, both facts
 * are stated and the reader judges.
 *
 * ── THE PATH IS A SECOND COPY, AND IT IS NAMED RATHER THAN HIDDEN ───────────────────────────────
 *
 * `DevLane.bootNotePath` in the app derives the same name from ITS module. These are separate packages
 * with no shared module between them, exactly as the router port already is, and `ports.mjs` counts that
 * cost. What the note does do is make the count reducible: a rig that can read the port the app actually
 * bound no longer has to agree with it in advance. That retirement is somebody else's task.
 */

/** The record the app writes. Every field is re-checked on read — this is a file on disk written by
 *  another process, and a shape assumed is a shape that throws on the day it changes. */
export interface BootNote {
	at:         string;
	pid:        number;
	packaged:   boolean;
	door:       'open' | 'shut';
	why:        string;
	fix:        string;
	wantedPort: number;
	boundPort:  number;
	tokenSet:   boolean;
}

/**
 * What came back from one path. THREE STATES, NOT TWO, and the third is the whole reason this is not a
 * nullable note: `absent` is a finding — no dev session ever booted on that port from this checkout —
 * while `unreadable` is a fault in the instrument itself. Folding them together would let a corrupted
 * note read as a quiet "the app never ran", which is the collapse this package exists to refuse.
 */
export type NoteRead =
	| { state: 'absent';     path: string }
	| { state: 'unreadable'; path: string; why: string }
	| { state: 'read';       path: string; note: BootNote }
	/** FOUR STATES SINCE DEFECT-252, and the fourth carries no `path` because there is none — the rig
	 *  could not work out which checkout to look in. It is deliberately not an `absent` with a guessed
	 *  path: that is how the old answer managed to report "no dev session has booted here" about a folder
	 *  no app has ever written to. The missing field is what stops a reader naming an address it does
	 *  not have. */
	| { state: 'unlocated' };

/**
 * A named cause, and whether it is one.
 *
 * `certain` is not confidence about the app — nothing here is confident about the app. It says whether a
 * NOTE WAS ACTUALLY READ, which decides how much the caller has to add: with a note there is one cause
 * and one fix and the old five-cause paragraph is noise, and without one the paragraph is still the best
 * available answer. That is what degrading to current behaviour means in practice.
 */
export interface Diagnosis {
	cause:   string;
	certain: boolean;
}

/**
 * Where the notes are: the TARGETED CHECKOUT's dev-scripts folder, which is the one answer
 * `Workspace` resolves and `server.ts` announces.
 *
 * ── IT USED TO BE DERIVED FROM THIS MODULE, AND THAT WAS DEFECT-252 ──
 *
 * This joined `__dirname` with two hops up, arguing — correctly — that a path depending on which shell
 * launched the process goes missing for reasons nobody can see. The conclusion did not follow. Two hops
 * up from this module is the checkout only while the rig RUNS FROM the checkout it targets; installed
 * under `C:\Program Files\starmind\resources\plugins\mcp\...` it addressed the install tree, where no
 * boot note has ever been written, and `dev_status` then reported the app down with the sentence "no dev
 * session has booted here". The rig was reading its own folder and calling it a finding about the app.
 *
 * The address now comes from the same place the rig's idea of "which checkout" comes from, so there is
 * one answer rather than two that agree by coincidence.
 */
export function bootNoteDir(): string | null {
	return Workspace.devScriptsDir();
}

/** The note for one port, or the one an app with no fixed port configured leaves behind. NO DEFAULT for
 *  `dir`: there is now a case where there is no directory at all, and a caller has to have decided what
 *  that means before it can ask for a path inside it. */
export function bootNotePath( key: number | 'ephemeral', dir: string ): string {
	return join( dir, `.dev-boot-${ key }.json` );
}

/** Read one. NEVER THROWS — an unreadable note must degrade the answer, never replace it with an
 *  exception, because an exception here is no answer at all where the old paragraph was a poor one.
 *  A null `dir` is `unlocated`: no path was looked at, so none is named. */
export function readNote( key: number | 'ephemeral', dir: string | null = bootNoteDir() ): NoteRead {
	if ( dir === null ) return { state: 'unlocated' };
	const path = bootNotePath( key, dir );
	let text: string;
	try { text = readFileSync( path, 'utf8' ); }
	catch ( err ) {
		// ENOENT is the ORDINARY case and is not a failure. Anything else — a permission, a directory
		// where a file should be — is the instrument being broken and is said as that.
		const code = ( err as NodeJS.ErrnoException ).code;
		return code === 'ENOENT' ? { state: 'absent', path } : { state: 'unreadable', path, why: code ?? String( err ) };
	}
	try {
		const raw  = JSON.parse( text ) as Partial<BootNote>;
		const door = raw.door === 'open' ? 'open' : 'shut';
		if ( typeof raw.at !== 'string' || typeof raw.boundPort !== 'number' ) {
			return { state: 'unreadable', path, why: 'the note is JSON but not a boot note' };
		}
		return { state: 'read', path, note: {
			at:         raw.at,
			pid:        typeof raw.pid === 'number' ? raw.pid : 0,
			packaged:   raw.packaged === true,
			door,
			why:        typeof raw.why === 'string' ? raw.why : '',
			fix:        typeof raw.fix === 'string' ? raw.fix : '',
			wantedPort: typeof raw.wantedPort === 'number' ? raw.wantedPort : 0,
			boundPort:  raw.boundPort,
			tokenSet:   raw.tokenSet === true
		} };
	} catch {
		return { state: 'unreadable', path, why: 'the note is not JSON' };
	}
}

/** Every note worth looking at for a walk that found nothing: one per port dialled, plus the one an
 *  unconfigured app leaves — because an app on an ephemeral port is exactly the state no fixed address
 *  can find, and refusing to look for its note would leave that state undiagnosable forever. */
export function readNotes( tried: number[], dir: string | null = bootNoteDir() ): NoteRead[] {
	// ONE unlocated read, not one per port. "I do not know where to look" is a single fact about the rig;
	// repeating it per candidate would dress an instrument fault up as a walk that covered ground.
	if ( dir === null ) return [ { state: 'unlocated' } ];
	return [ ...tried.map( ( port ) => readNote( port, dir ) ), readNote( 'ephemeral', dir ) ];
}

/** How long ago, in words a reader can weigh. Age is half of what a note is worth: the same sentence
 *  means something different at forty seconds and at nine days. */
function ago( at: string, now: number ): string {
	const then = Date.parse( at );
	if ( Number.isNaN( then ) ) return `timestamped "${ at }", which is not a readable date`;
	const mins = Math.round( ( now - then ) / 60_000 );
	if ( mins < 0 )   return `written at ${ at }, which is IN THE FUTURE on this clock`;
	if ( mins < 60 )  return `written ${ mins } minute( s ) ago, at ${ at }`;
	if ( mins < 1440 ) return `written ${ Math.round( mins / 60 ) } hour( s ) ago, at ${ at }`;
	return `written ${ Math.round( mins / 1440 ) } day( s ) ago, at ${ at }`;
}

/** The sentence that has to ride every note-derived cause, so no reader can quote one as a statement
 *  about now. The note is a record of a boot; the silence on the socket is the present tense. */
const NOT_NOW = 'A note records what the app DID at that boot. It does not say whether the app is running '
	+ 'now, and nothing here claims it is.';

/**
 * ONE CAUSE, from whatever evidence there is. Pure — it reads no disk and no clock — so all seven states
 * are provable with no app running, which is the point.
 *
 * THE ORDER OF THE BRANCHES IS THE DIAGNOSIS. Staleness is asked first, because a note describing a
 * different boot cannot be read for door state at all and every branch below it would be answering about
 * the wrong process.
 */
export function explain( tried: number[], reads: NoteRead[], reached: AppStamp | null, now: number ): Diagnosis {
	const found  = reads.find( ( r ): r is Extract<NoteRead, { state: 'read' }> => r.state === 'read' );
	const broken = reads.find( ( r ): r is Extract<NoteRead, { state: 'unreadable' }> => r.state === 'unreadable' );

	if ( !found ) {
		// ── I DO NOT KNOW WHERE TO LOOK. Asked BEFORE the absent branch, because every sentence below it
		// is a claim about the app and this one is a claim about the rig. `certain: false`, so the caller
		// still prints the five-cause paragraph: nothing here has narrowed anything down.
		if ( reads.some( ( r ) => r.state === 'unlocated' ) ) {
			return { certain: false, cause:
				'THIS RIG COULD NOT WORK OUT WHICH CHECKOUT TO LOOK IN, so NO boot note was looked for and ' +
				'nothing below is a finding about the app. A boot note lives at ' +
				'`<checkout>/starmind/scripts/dev/.dev-boot-<port>.json`, and the checkout is resolved by ' +
				'`--root` on argv, then STARMIND_DEV_ROOT, then a walk up from this server\'s working ' +
				'directory looking for a `_Claude/` vault beside a `scripts/` folder — all three missed. ' +
				'Set STARMIND_DEV_ROOT to the checkout on this server\'s card in Servers & Tools, or export ' +
				'it when running standalone; the server announces the root it resolved on stderr at startup.' };
		}
		if ( broken ) {
			return { certain: false, cause:
				`A BOOT NOTE IS THERE AND COULD NOT BE READ: \`${ broken.path }\` ( ${ broken.why } ). That is a ` +
				'fault in the instrument, not a finding about the app, so the diagnosis below is the older ' +
				'one that names every cause rather than picking one. Deleting the file is safe — the app ' +
				'rewrites it at its next boot.' };
		}
		// LOOKED AND FOUND NOTHING — which is only worth saying because the branch above has already
		// ruled out the other shape of emptiness. Every path looked at is named, so the reader can check
		// the claim against the checkout they think they are pointing at ( DEFECT-252: the old version of
		// this sentence was asserted about an INSTALL tree nothing writes notes to ).
		return { certain: false, cause:
			`NO BOOT NOTE: I LOOKED AT ${ reads.filter( ( r ) => r.state !== 'unlocated' ).map( ( r ) => '`' + r.path + '`' ).join( ', ' ) } ` +
			'AND FOUND NOTHING THERE. Check those paths are inside the checkout you mean — they are resolved ' +
			'against the root this server announced on stderr at startup. If they are, the app writes a note ' +
			'at every boot from a checkout, so an absent one most likely means no dev session has booted ' +
			'there — the app is not running. That is a finding rather than an error: nothing is missing that ' +
			'should be there. The two other readings are an app built before the note existed, which needs a ' +
			'full restart to gain it because main-process code does not hot-reload, and an app running from a ' +
			'DIFFERENT checkout than the one addressed above.' };
	}

	const note = found.note;
	const age  = ago( note.at, now );

	// ── STALE. The note is about a different process than the one this rig has spoken to, so nothing in
	// it describes the app in question. Its own finding, and it must not be read past.
	if ( reached && reached.pid !== note.pid ) {
		return { certain: true, cause:
			`THE BOOT NOTE IS STALE. \`${ found.path }\` was ${ age } by pid ${ note.pid }, but the app this ` +
			`rig last spoke to is pid ${ reached.pid } on port ${ reached.port }. The note describes an ` +
			'EARLIER boot, so its door state says nothing about the app you are asking about. The fix is to ' +
			'restart the app so it rewrites the note, then ask again.' };
	}

	if ( note.door === 'shut' ) {
		return { certain: true, cause:
			`THE APP BOOTED AND THE DEV DOOR IS SHUT — this is the app's own account, from \`${ found.path }\`, ` +
			`${ age } by pid ${ note.pid }. In its words: "${ note.why }". ${ note.fix } ${ NOT_NOW }` };
	}

	if ( note.boundPort === 0 ) {
		return { certain: true, cause:
			`THE DEV DOOR OPENED AND THE ROUTER NEVER BOUND A PORT. \`${ found.path }\`, ${ age }, records ` +
			`door open and bound port 0. The listener failed to come up, so there is no address to dial at ` +
			'all. Look on the WARNINGS trace channel for the bind failure, and at the supervisor log below. ' +
			NOT_NOW };
	}

	if ( note.wantedPort === 0 ) {
		return { certain: true, cause:
			`THE APP IS ON AN EPHEMERAL PORT, which no fixed address can reach. \`${ found.path }\`, ${ age }, ` +
			`records the dev door OPEN with nothing configured as a fixed port, so the router bound ` +
			`${ note.boundPort } for that boot and will bind a different one at the next. Set ` +
			`STARMIND_ROUTER_PORT=${ tried[ 0 ] ?? note.boundPort } in \`starmind/.env\` and restart the app. ` +
			NOT_NOW };
	}

	if ( note.boundPort !== note.wantedPort ) {
		return { certain: true, cause:
			`THE FIXED PORT WAS TAKEN AND THE APP FELL BACK. \`${ found.path }\`, ${ age }, records that it ` +
			`asked for ${ note.wantedPort } and bound ${ note.boundPort }. A taken fixed port falls back to ` +
			'ephemeral on purpose rather than failing the whole harness, so the ordinary cause is a SECOND ' +
			`Starmind already holding ${ note.wantedPort }. Quit the other copy and restart this one. ` + NOT_NOW };
	}

	if ( !tried.includes( note.boundPort ) ) {
		return { certain: true, cause:
			`THE APP AND THIS RIG DISAGREE ABOUT THE PORT. \`${ found.path }\`, ${ age }, records the door open ` +
			`on ${ note.boundPort }; this rig dialled ${ tried.join( ', ' ) }. Set STARMIND_DEV_PORT to ` +
			`${ note.boundPort } on this server's card in Servers & Tools, or export it when running ` +
			'standalone. ' + NOT_NOW };
	}

	// ── BOTH FACTS, NEITHER ADJUDICATED. The note says the door opened on the very port that answers
	// nothing. Saying "the app is up" here because the note says so is exactly the confident wrong answer
	// this whole mechanism replaces.
	return { certain: true, cause:
		`THE NOTE AND THE SOCKET DISAGREE, and both facts are stated rather than one of them chosen. ` +
		`\`${ found.path }\`, ${ age } by pid ${ note.pid }, records the dev door OPEN on port ` +
		`${ note.boundPort } — and nothing answers that port now. The likeliest reading is that the app has ` +
		'since exited, or is still starting. ' + NOT_NOW };
}

/** The impure half: read the notes for this walk and name one cause. Kept to one line so that everything
 *  worth testing is in `explain`, which needs neither a disk nor an app. */
export function diagnose( tried: number[], reached: AppStamp | null, dir: string | null = bootNoteDir() ): Diagnosis {
	return explain( tried, readNotes( tried, dir ), reached, Date.now() );
}

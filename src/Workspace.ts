import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Workspace — which checkout this process is pointed at.
 *
 * ONE FACT. The tools ask a running application, which knows its own project, so none of them needs
 * this to do its work — what needs it is `server.ts`, which announces the resolved root on stderr at
 * startup, and `devScriptsDir()` below. That announcement is the only report anybody gets of where the
 * walk and `STARMIND_DEV_ROOT` actually landed, and a server pointed at the wrong checkout looks
 * identical from the client's side, so it is worth being fussy about.
 *
 * ── THE SECOND CALLER ARRIVED ON 2026-10-01, AND IT ARRIVED AS A DEFECT ( DEFECT-252 ) ──
 *
 * `BootNote.bootNoteDir` and `Door.supervisorLogLine` both resolved the app's dev-scripts folder off
 * `__dirname` with two hops up, each with a doc-block explaining that a `cwd()`-derived path "goes
 * missing for reasons nobody can see". That reasoning was sound and the conclusion was still wrong: two
 * hops up from THIS MODULE is the checkout only when the rig is running from the checkout it targets.
 * Installed — `C:\Program Files\starmind\resources\plugins\mcp\...` — it addressed its own install tree,
 * where nothing has ever written a boot note, and then reported `app-down` with the confident sentence
 * "no dev session has booted here". A false negative on the ONE call whose success is the statement
 * that the app is up.
 *
 * So the rule is: ONE ANSWER about which checkout this process targets, resolved here, ANNOUNCED by
 * `server.ts`, and used by everything that needs a path into it. A reader who wants to know where the
 * rig looked reads the startup line, and it is the same place.
 *
 * THE CENSUS HALF STOOD HERE UNTIL 2026-09-30 — `subProjects`, `testFiles` and `packageJson`, the
 * inputs `test_census` and `run_suite` read the tree with. Both tools retired to `sm_testing`
 * ( see `server.ts` ), and these three had no other caller, so they went with them rather than
 * staying as a tree-reading facility nothing reads.
 *
 * RESOLUTION ORDER, most explicit first:
 *
 *   1. `--root <path>` on argv          — a caller placing the server deliberately
 *   2. `STARMIND_DEV_ROOT`              — a DECLARED SETTING, answered on this server's card
 *   3. walk UP from cwd                 — the ordinary case
 *
 * RUNG 2 IS A FIELD, and the order did not have to change to make it one. It is declared in this
 * server's manifest with NO DEFAULT, deliberately: a field that declares one resolves to it and the
 * variable is always present, which would retire the walk for everybody to serve the few machines that
 * need a fixed answer. Declaring no default means the variable appears only when somebody actually fills
 * it in, so rung 3 stays the ordinary path and rung 2 is what a person reaches for when the walk lands
 * somewhere wrong.
 *
 * THE WALK IS SLIGHTLY LUCKY. Starmind spawns this server with the default project's root as its
 * working directory, so walking up from cwd finds the checkout — on a machine where the default
 * project IS the checkout. That is true today and is a coincidence rather than a guarantee, which is
 * the whole reason rung 2 is worth surfacing.
 *
 * The walk looks for a directory that is a workspace ROOT rather than merely a package: the marker
 * is a `_Claude/` vault beside a `scripts/` folder. A bare `package.json` is the wrong marker here —
 * every sub-project has one, so a server started from inside `kcd_sdk/` would stop at `kcd_sdk/` and
 * announce one fifth of the tree while looking complete.
 *
 * NOT FINDING A ROOT IS AN ANSWER, NOT A CRASH. `find()` returns null and the caller says so in its
 * own words — `server.ts` announces `( none found )`. A test rig that throws on startup because it was
 * launched from an unexpected directory is a rig nobody can debug, and a rig is wanted most in
 * awkward circumstances.
 */
export class Workspace {

	/** Cached because the answer cannot change inside one process — a long-lived server never
	 *  legitimately moves workspace, so the walk is worth doing exactly once. */
	private static _root: string | null | undefined = undefined;

	/** The workspace root, or null when this process is not inside one. */
	static find(): string | null {
		if ( this._root !== undefined ) return this._root;
		this._root = this._resolve();
		return this._root;
	}

	private static _resolve(): string | null {
		const flagAt = process.argv.indexOf( '--root' );
		if ( flagAt >= 0 && process.argv[ flagAt + 1 ] ) return resolve( process.argv[ flagAt + 1 ]! );

		const fromEnv = process.env[ 'STARMIND_DEV_ROOT' ];
		if ( fromEnv ) return resolve( fromEnv );

		let dir = process.cwd();
		// Stop at the filesystem root: dirname('/') === '/' and dirname('C:\\') === 'C:\\', so the
		// terminating condition is "the parent is myself" rather than any path-shape assumption.
		for ( ;; ) {
			if ( this.isRoot( dir ) ) return dir;
			const up = dirname( dir );
			if ( up === dir ) return null;
			dir = up;
		}
	}

	/**
	 * The TARGETED CHECKOUT's `starmind/scripts/dev` — where the app writes its boot notes and where
	 * `dev-proxied.mjs` writes its supervisor logs. The one address for both, so the two readers cannot
	 * drift apart or disagree with the root `server.ts` announced.
	 *
	 * NULL IS A DIFFERENT FACT FROM AN EMPTY FOLDER, and keeping them apart is the whole of DEFECT-252's
	 * fourth exit: null is "I do not know which checkout to look in", and a reader that folds it into
	 * "I looked and found nothing" reports a finding about the APP from a fault in the INSTRUMENT. Both
	 * callers say which one they mean, in their own words.
	 *
	 * Costs no I/O after the first call — `find()` caches, and `server.ts` has already spent it
	 * announcing the root before any tool runs.
	 */
	static devScriptsDir(): string | null {
		const root = this.find();
		return root === null ? null : join( root, 'starmind', 'scripts', 'dev' );
	}

	/** A workspace root carries the vault AND the workspace-level scripts folder. Either alone is
	 *  ambiguous — a deployed vault can sit beside things that are not this repo. */
	static isRoot( dir: string ): boolean {
		return existsSync( join( dir, '_Claude' ) ) && existsSync( join( dir, 'scripts' ) );
	}
}

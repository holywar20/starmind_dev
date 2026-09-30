import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Workspace — which checkout this process is pointed at.
 *
 * ONE FACT AND ONE CALLER, since 2026-09-30. The tools ask a running application, which knows its own
 * project, so none of them needs this — what needs it is `server.ts`, which announces the resolved
 * root on stderr at startup. That announcement is the only report anybody gets of where the walk and
 * `STARMIND_DEV_ROOT` actually landed, and a server pointed at the wrong checkout looks identical
 * from the client's side, so it is worth being fussy about.
 *
 * THE CENSUS HALF STOOD HERE UNTIL 2026-09-30 — `subProjects`, `testFiles` and `packageJson`, the
 * inputs `test_census` and `run_suite` read the tree with. Both tools retired to `testing_vitest`
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

	/** A workspace root carries the vault AND the workspace-level scripts folder. Either alone is
	 *  ambiguous — a deployed vault can sit beside things that are not this repo. */
	static isRoot( dir: string ): boolean {
		return existsSync( join( dir, '_Claude' ) ) && existsSync( join( dir, 'scripts' ) );
	}
}

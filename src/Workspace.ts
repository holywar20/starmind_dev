import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Workspace — where the tree under test is, and what is in it.
 *
 * Every COLD tool needs one fact before it can do anything: the workspace root. The HOT tools will
 * not — they ask a running application, which knows its own project. So this is the cold half's
 * single piece of orientation, and it is worth being fussy about because getting it wrong means a
 * tool that reports confidently about the wrong directory.
 *
 * RESOLUTION ORDER, most explicit first:
 *
 *   1. `--root <path>` on argv          — a caller placing the server deliberately
 *   2. `STARMIND_DEV_ROOT`              — a fixed answer for a fixed machine
 *   3. walk UP from cwd                 — the ordinary case
 *
 * The walk looks for a directory that is a workspace ROOT rather than merely a package: the marker
 * is a `_Claude/` vault beside a `scripts/` folder. A bare `package.json` is the wrong marker here —
 * every sub-project has one, so a server started from inside `kcd_sdk/` would stop at `kcd_sdk/` and
 * every census it took would describe one fifth of the tree while looking complete.
 *
 * NOT FINDING A ROOT IS AN ANSWER, NOT A CRASH. `find()` returns null and each tool reports it in
 * its own words. A test rig that throws on startup because it was launched from an unexpected
 * directory is a rig nobody can debug — the whole point of the cold half is that it works in
 * awkward circumstances.
 */
export class Workspace {

	/** Cached because every tool call would otherwise re-walk the filesystem for the same answer. */
	private static _root: string | null | undefined = undefined;

	/** The workspace root, or null when this process is not inside one. */
	static find(): string | null {
		if ( this._root !== undefined ) return this._root;
		this._root = this._resolve();
		return this._root;
	}

	/** Clear the cache. Tests only — a long-lived server never legitimately changes workspace. */
	static reset(): void {
		this._root = undefined;
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

	// ── The census inputs ─────────────────────────────────────────────────────────

	/**
	 * Sub-projects: directories with a `package.json`, two levels deep, skipping build output.
	 *
	 * DELIBERATELY MIRRORS `scripts/test-all.mjs` rather than importing it — that file is an ESM script
	 * with top-level side effects ( it RUNS the suites ), so importing it would run them. The duplication
	 * is real and is the smaller cost. If these two ever disagree the census is the one that is wrong,
	 * because the aggregator is what actually executes.
	 */
	static subProjects( root: string ): string[] {
		const NEVER = new Set( [ 'node_modules', '.git', 'dist', 'out', 'build', '.vite' ] );
		const found: string[] = [];

		const walk = ( dir: string, depth: number ): void => {
			if ( depth < 0 ) return;
			let entries;
			try { entries = readdirSync( dir, { withFileTypes: true } ); }
			catch { return; }

			for ( const entry of entries ) {
				if ( !entry.isDirectory() )         continue;
				if ( NEVER.has( entry.name ) )      continue;
				if ( entry.name.startsWith( '.' ) ) continue;

				const child = join( dir, entry.name );
				if ( existsSync( join( child, 'package.json' ) ) ) found.push( child );
				walk( child, depth - 1 );
			}
		};

		walk( root, 1 );
		return found.sort();
	}

	/** Every `*.test.ts` under a directory, excluding build output. The census counts these; nothing
	 *  here reads them, which is the line between the mechanical half and the judgment half. */
	static testFiles( dir: string ): string[] {
		const NEVER = new Set( [ 'node_modules', '.git', 'dist', 'out', 'build', '.vite' ] );
		const found: string[] = [];

		const walk = ( at: string ): void => {
			let entries;
			try { entries = readdirSync( at, { withFileTypes: true } ); }
			catch { return; }
			for ( const entry of entries ) {
				const child = join( at, entry.name );
				if ( entry.isDirectory() ) {
					if ( NEVER.has( entry.name ) || entry.name.startsWith( '.' ) ) continue;
					walk( child );
				}
				else if ( entry.name.endsWith( '.test.ts' ) ) found.push( child );
			}
		};

		walk( dir );
		return found;
	}

	/** A package.json as a plain object, or null. A malformed one is reported by the caller rather than
	 *  thrown on — one unparseable file must not take a whole census down with it. */
	static packageJson( dir: string ): Record<string, unknown> | null {
		try { return JSON.parse( readFileSync( join( dir, 'package.json' ), 'utf8' ) ) as Record<string, unknown>; }
		catch { return null; }
	}
}

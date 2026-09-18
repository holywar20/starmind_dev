import * as path from 'path';
import type { ToolDefinition } from './mcp';

/**
 * Reload — re-evaluate the tool modules inside a living process.
 *
 * ── THE PROBLEM THIS SOLVES, WHICH IS NOT THE OBVIOUS ONE ───────────────────────────────────────
 *
 * A tool written during a session could not be called during that session, and the visible reason was
 * that the client reads `tools/list` once at spawn. That is true, and it is the LAST of three locks
 * rather than the only one. Measured 2026-09-09:
 *
 *   1. the client holds the roster it read at spawn                    ( fixed by `listChanged` )
 *   2. `StarmindDevServer` builds its table in the CONSTRUCTOR         ( fixed by `replaceTools` )
 *   3. the module cache returns the same functions however often
 *      you re-run the factories                                        ( fixed HERE )
 *
 * Fixing only the first would notify a client to re-read a list that could not have changed. Fixing
 * only the first two would re-run factories that hand back the identical closures. All three, or the
 * work buys nothing — which is why this exists as its own module rather than a line in the server.
 *
 * ── THE PURGE IS BY DIRECTORY, AND STOPS AT THE PACKAGE EDGE ────────────────────────────────────
 *
 * Everything under `src/` is dropped from the require cache except the machinery currently executing
 * — this module, the server, the entry, and the wire. Editing `Door.ts` or `Surface.ts` should take
 * effect just as much as editing a tool file, so the unit of reload is OUR SOURCE rather than the
 * three tool files. It deliberately does NOT reach `@kcd/core`: that is a dependency being read, not
 * a surface being authored, and re-evaluating the SDK on every reload would buy nothing.
 *
 * Both module-level caches downstream ( `Workspace._root`, `Surface._map` ) are derived from facts
 * that do not change, so a second copy re-derives the same answer. Checked before relying on it.
 */

export type ReloadResult =
	| { ok: true;  tools: ToolDefinition[] }
	| { ok: false; error: string };

/**
 * The modules that must NOT be re-evaluated: they are on the stack while the reload runs. Swapping
 * the class out from under the live server instance would leave two definitions of the wire in play
 * and no way to tell which one a given object came from.
 */
const KEEP = [ 'Reload', 'server', 'index' ];

/**
 * Running from source, or from the esbuild bundle?
 *
 * IT DECIDES WHETHER RELOAD IS POSSIBLE AT ALL, so it is a real question rather than a defensive
 * check. `dist/index.js` is ONE file with every module inlined: there are no separate cache entries
 * to drop, and a purge there would find nothing and silently appear to succeed. That case gets a
 * named refusal instead.
 */
function fromSource(): boolean {
	return __filename.endsWith( '.ts' );
}

export const Reload = new class Reload {

	/**
	 * Re-read the tool modules and return the fresh table.
	 *
	 * TRANSACTIONAL BY CONSTRUCTION: nothing is swapped here. The caller receives a complete table or
	 * an error, so a module that throws on import — a typo in a tool being written, which is the
	 * common case in a nursery — leaves the live roster exactly as it was. Emptying someone's toolbox
	 * because they mistyped the tool they were adding is the one outcome this must never produce.
	 */
	async tools(): Promise<ReloadResult> {
		if ( !fromSource() ) {
			return { ok: false, error:
				'reload needs the source modules, and this process was launched from the bundle at dist/index.js, ' +
				'where every module is inlined into one file. Launch through tsx ( which is what .mcp.json does ) ' +
				'to reload in place; from the bundle, a client restart is still the only path.' };
		}

		try {
			this.purge();
			const cold   = require( './tools/cold' )   as { coldTools:   () => ToolDefinition[] };
			const hot    = require( './tools/hot' )    as { hotTools:    () => ToolDefinition[] };
			const fluent = require( './tools/fluent' ) as { fluentTools: () => ToolDefinition[] };

			return { ok: true, tools: [ ...cold.coldTools(), ...hot.hotTools(), ...fluent.fluentTools() ] };
		} catch ( e ) {
			// The import error is the whole value here — it is the compile error for the tool someone is
			// mid-way through writing, and it is the only place they will see it.
			return { ok: false, error: e instanceof Error ? e.message : String( e ) };
		}
	}

	/**
	 * Drop this package's own source from the require cache, in ONE pass before anything is re-required.
	 *
	 * ALL AT ONCE, NOT PER MODULE. Purging between requires would let the first module repopulate a
	 * shared dependency that the second then purges and reloads — two vintages of `Door` alive in one
	 * roster, which is the kind of fault that presents as an impossible bug much later.
	 */
	private purge(): string[] {
		const here    = __dirname + path.sep;
		const dropped: string[] = [];

		for ( const key of Object.keys( require.cache ) ) {
			if ( !key.startsWith( here ) ) continue;
			if ( key.startsWith( path.join( __dirname, 'mcp' ) ) ) continue;
			if ( KEEP.includes( path.basename( key, path.extname( key ) ) ) ) continue;
			delete require.cache[ key ];
			dropped.push( key );
		}
		return dropped;
	}
}();

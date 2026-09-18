/**
 * Build script — esbuild bundles the server into one self-contained file under dist/.
 *
 * Modelled on daedalus's, minus the CLI face it does not have.
 *
 * ── ONE ALIAS, AND IT WAS ADDED KNOWINGLY ───────────────────────────────────────────────────────
 *
 * This file used to say that resolving NOTHING outside the package was the property worth protecting
 * — a test rig should not fail to build because something it tests moved. That was right about cold
 * tools and wrong the moment the hot half arrived.
 *
 * `spawn_agent` has to know which tools an agent injects, and that answer is `suggestedToolNames()`
 * on the SDK's Agent — a composition over the agent's own tool modes and every lens's. Computing it
 * from the wire JSON by hand would be a SECOND IMPLEMENTATION of a composition rule, and when the two
 * drifted, every dev-spawned turn would quietly run with a different tool surface from a real one.
 * That is the exact failure this whole surface exists to catch, installed in the surface itself.
 *
 * So the isolation is traded for correctness, and the trade is narrow: `@kcd/core` is the Node-free
 * half, it is the SAME door the renderer imports through, and rehydrating there is the established
 * idiom rather than a new one. From source, one hop, so the checker and the bundler agree.
 *
 * esbuild ( not tsc ) for the emit: it strips types without type-checking. Type-checking is a
 * separate, earlier step — `npm run build` runs `tsc --noEmit` first, so the checker and the bundler
 * never disagree about what they read.
 *
 * THE BUILD IS OPTIONAL, WHICH IS DELIBERATE. `npm start` runs the TypeScript directly through tsx,
 * and that is the ordinary way to use this server. A dev tool gated behind a build step is a dev
 * tool that is stale exactly when someone is changing things quickly, which is the only time it gets
 * used. dist/ exists for the case where a bundled single file is more convenient to spawn; nothing
 * depends on it and nothing commits it.
 */
const esbuild = require( 'esbuild' );
const path    = require( 'path' );

const KCD_CORE = path.resolve( __dirname, '..', 'kcd_sdk', 'src', 'core', 'index.ts' );

esbuild.buildSync( {
	entryPoints: [ 'src/index.ts' ],
	outfile:     'dist/index.js',
	bundle:      true,
	platform:    'node',
	target:      'node20',
	sourcemap:   true,
	alias:       { '@kcd/core': KCD_CORE },
} );

console.log( 'build complete → dist/index.js (self-contained; no external resolution)' );

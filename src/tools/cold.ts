import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';

import { Workspace } from '../Workspace';
import type { ToolDefinition, ToolResult } from '../mcp';

/**
 * The COLD tools — everything that works with no application running.
 *
 * This is the half that justifies the server existing standalone at all. Every tool the previous
 * in-process surface had was HOT ( it called a bus verb, so it died with the app ), which meant
 * extraction on its own would have bought nothing: the same nine tools, unavailable at the same
 * times, reachable through one more hop. The cold tools are the actual dividend, and they depend on
 * no door, no token and no running app — so they land first and prove the package stands up alone
 * before anything relies on it doing so.
 *
 */

/** JSON text is the return currency — a ToolResult carries text blocks, and an agent parsing one
 *  object beats an agent parsing prose. Pretty-printed because a human reads these too. */
function ok( value: unknown ): ToolResult {
	return { content: [ { type: 'text', text: JSON.stringify( value, null, 2 ) } ] };
}

function fail( message: string ): ToolResult {
	return { content: [ { type: 'text', text: message } ], isError: true };
}

/** How much of a run's END comes back in the answer. Big enough to hold vitest's summary block and a
 *  failure or two under it, small enough that a green run and a red one both fit in one tool result —
 *  the whole document is on disk either way, so this only decides how often a second call is needed. */
const TAIL_CHARS = 4_000;

/** Shared by every cold tool: they are all useless without a workspace, and all say so identically. */
function requireRoot(): { root: string } | { error: ToolResult } {
	const root = Workspace.find();
	if ( !root ) {
		return { error: fail(
			'No workspace root found. starmind_dev looks for a directory holding both `_Claude/` and ' +
			'`scripts/`, walking up from the working directory. Pass `--root <path>` on the command line ' +
			'or set STARMIND_DEV_ROOT to place it explicitly.'
		) };
	}
	return { root };
}

export function coldTools(): ToolDefinition[] {
	return [

		{
			name:        'test_census',
			annotations: { readOnlyHint: true },
			description: 'Take the testing census across the whole workspace — every sub-project, its runner, its test-file count, and whether anything measures coverage. Reads the tree; runs nothing.',
			doc:
				'THE ORIENTATION CALL. Taking this census by hand costs roughly forty minutes and a large ' +
				'fraction of a context window, and every pass in it is mechanical — count `*.test.ts` per ' +
				'sub-project, read each `package.json` and vitest config, check for coverage tooling, and ' +
				'diff what is present against what the aggregator would run.\n\n' +
				'WHAT IT DOES NOT DO, on purpose: it counts test files, it does not read them. Whether a ' +
				'given file is a real assertion or a smoke pass is judgment, and mixing judgment into a ' +
				'census is how a measurement stops being re-runnable. The numbers here are the denominator; ' +
				'what they mean is a separate question with a separate owner.\n\n' +
				'`mechanism` is the important column and the one a file count hides: configured vitest, ' +
				'config-less vitest and an in-process spec run are three different things that a single ' +
				'"tests: N" number would flatten into one.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler:     async () => {
				const got = requireRoot();
				if ( 'error' in got ) return got.error;
				const { root } = got;

				const projects = Workspace.subProjects( root ).map( ( dir ) => {
					const pkg     = Workspace.packageJson( dir );
					const scripts = ( pkg?.[ 'scripts' ] ?? {} ) as Record<string, string>;
					const dev     = ( pkg?.[ 'devDependencies' ] ?? {} ) as Record<string, string>;
					const deps    = ( pkg?.[ 'dependencies' ] ?? {} ) as Record<string, string>;

					const vitest    = dev[ 'vitest' ] ?? deps[ 'vitest' ] ?? null;
					const hasConfig = [ 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts' ]
						.some( ( f ) => existsSync( join( dir, f ) ) );
					const files     = Workspace.testFiles( dir );

					// The runner a suite ACTUALLY has, which is not always the one its file count implies.
					// A package with no vitest and no test script still gets a row — an absent suite is a
					// fact worth reporting, and it is the fact a hand-written list loses.
					const mechanism =
						vitest && hasConfig ? 'vitest ( configured )'
						: vitest            ? 'vitest ( NO CONFIG — defaults, inherited rather than chosen )'
						: scripts[ 'verify' ] ? 'in-process spec run ( not a test runner )'
						: 'none';

					return {
						project:   relative( root, dir ).replaceAll( '\\', '/' ),
						mechanism,
						testFiles: files.length,
						vitest,
						hasConfig,
						scripts:   Object.keys( scripts ).filter( ( k ) => k === 'test' || k === 'verify' ),
						// Coverage has been claimed to be absent project-wide several times without anyone
						// re-checking. Cheap to verify, so it gets verified on every census rather than
						// remembered.
						coverage:  JSON.stringify( pkg ?? {} ).includes( 'coverage' ),
						malformedPackageJson: pkg === null
					};
				} );

				const runnable = projects.filter( ( p ) => p.scripts.length > 0 );

				return ok( {
					root,
					takenAt:      new Date().toISOString(),
					subProjects:  projects.length,
					runnable:     runnable.length,
					noSuite:      projects.filter( ( p ) => p.scripts.length === 0 ).map( ( p ) => p.project ),
					totalTestFiles: projects.reduce( ( n, p ) => n + p.testFiles, 0 ),
					mechanisms:   [ ...new Set( projects.map( ( p ) => p.mechanism ) ) ].filter( ( m ) => m !== 'none' ),
					anyCoverage:  projects.some( ( p ) => p.coverage ),
					projects,
					note: 'A snapshot. Counts drift — the previous hand-taken census moved materially inside ten days. ' +
					      'Re-run rather than remembering, and note this counts files without reading them.'
				} );
			}
		},

		{
			name:        'run_suite',
			annotations: { readOnlyHint: false },
			description: 'Run one sub-project\'s test suite, or the whole workspace. Writes the whole run to `testresults/<suite>.txt` under the workspace root and returns the verdict plus the tail of the output.',
			doc:
				'Thin caller of the npm script a person would run — `npm run test` in one sub-project, or the ' +
				'workspace aggregator. It does NOT reimplement running tests, and if the aggregator learns to ' +
				'discover a new sub-project this tool learns it too, because it is the same command.\n\n' +
				'A NOTE ON TIME, because it is the way this tool fails. A full workspace run is several ' +
				'minutes and MCP tool calls sit behind a client timeout ( 180s here ). So `suite` defaults to ' +
				'ONE sub-project and the whole workspace must be asked for explicitly with `suite: "all"` — a ' +
				'slow call is a bad default when the fast one is what is wanted nine times in ten. If a run ' +
				'does exceed the timeout the tests still complete; the caller just loses the answer, which is ' +
				'worth knowing before concluding anything from a timeout.\n\n' +
				'THE WHOLE RUN GOES TO DISK, at `testresults/<suite>.txt` under the workspace root, and what ' +
				'comes back is the VERDICT plus the tail — the end of the output, where both the failures and ' +
				'the summary line print. Nothing is scraped, summarised or interpreted on the way: the file is ' +
				'the run verbatim, and the tail is a literal slice of its end. This is still not the structured ' +
				'results record — that is a later, separate thing that captures a stack trace at the point of ' +
				'failure rather than scraping it back out of text afterwards.\n\n' +
				'WHY DISK ( 2026-09-27 ). Returning the output whole is what kept losing it. A large suite ' +
				'overflows the tool-result cap however quiet the reporter is — this one still answered ~294,000 ' +
				'characters under `dot`, most of it the suites\' own console noise — and an overflowed result is ' +
				'spilled to a path inside the app\'s profile directory, which a caller\'s file tools are not ' +
				'permitted to read. So the answer existed and nobody could open it, twice in a row, and the run ' +
				'was reported as unverified. A path inside the workspace is greppable by the same agent that ' +
				'asked for the run, which is the entire difference. One file PER SUITE, overwritten each run: ' +
				'these are disposable and a timestamped pile would need sweeping, but the name has to be ' +
				'predictable or the grep needs a second call to find it.\n\n' +
				'QUIET BY DEFAULT ( 2026-09-26 ). The run asks vitest for its `dot` reporter, which prints one ' +
				'character per passing file and the full detail of every failure. Pass `verbose: true` for the ' +
				'full render — it costs nothing now that the report is a file.',
			inputSchema: {
				type:       'object',
				properties: {
					suite:     { type: 'string', description: 'Sub-project name ( e.g. "kcd_sdk" ), or "all" for the whole workspace. Omit to list what is runnable.' },
					timeoutMs: { type: 'number', description: 'Kill the run after this long. Default 170000, just under the usual client timeout.' },
					verbose:   { type: 'boolean', description: 'Ask for vitest\'s DEFAULT reporter — a line per passing file. Off by default; a large suite\'s full render will not fit in one tool result.' }
				},
				required: []
			},
			handler: async ( args ) => {
				const got = requireRoot();
				if ( 'error' in got ) return got.error;
				const { root } = got;

				const suite     = typeof args[ 'suite' ] === 'string' ? args[ 'suite' ] as string : null;
				const timeoutMs = typeof args[ 'timeoutMs' ] === 'number' ? args[ 'timeoutMs' ] as number : 170_000;
				const verbose   = args[ 'verbose' ] === true;

				const available = Workspace.subProjects( root )
					.map( ( dir ) => ( { dir, name: relative( root, dir ).replaceAll( '\\', '/' ), pkg: Workspace.packageJson( dir ) } ) )
					.map( ( p ) => {
						const scripts = ( p.pkg?.[ 'scripts' ] ?? {} ) as Record<string, string>;
						return { ...p, script: scripts[ 'test' ] ? 'test' : scripts[ 'verify' ] ? 'verify' : null };
					} );

				// No argument is a QUESTION, not a request to run everything. Running four suites because a
				// caller omitted a field is the kind of expensive surprise a tool should never spring.
				if ( !suite ) {
					return ok( {
						hint:     'Pass `suite` with one of these names, or "all" for the whole workspace.',
						runnable: available.filter( ( p ) => p.script ).map( ( p ) => ( { suite: p.name, script: p.script } ) ),
						noSuite:  available.filter( ( p ) => !p.script ).map( ( p ) => p.name )
					} );
				}

				const target = suite === 'all'
					? { cwd: root, script: 'test:all', name: 'all', runner: 'aggregator' }
					: ( () => {
						const found = available.find( ( p ) => p.name === suite || basename( p.dir ) === suite );
						if ( !found )        return { error: `No sub-project named "${ suite }". Call run_suite with no arguments to list them.` };
						if ( !found.script ) return { error: `"${ found.name }" has no test or verify script — there is nothing to run. This is a fact about the sub-project, not a failure of this call.` };
						// WHAT THE SCRIPT ACTUALLY RUNS, read off the package rather than assumed. The reporter
						// flag below is vitest's, and a sub-project is free to test with something else — so the
						// quieting is offered only where the command provably understands it. A tool that
						// appended a foreign flag to a stranger's runner would turn "quieter" into "broken".
						const scripts = ( found.pkg?.[ 'scripts' ] ?? {} ) as Record<string, string>;
						const runner  = /\bvitest\b/.test( scripts[ found.script ] ?? '' ) ? 'vitest' : 'other';
						return { cwd: found.dir, script: found.script, name: found.name, runner };
					} )();

				if ( 'error' in target ) return fail( target.error );

				// `--` FIRST: npm hands everything after it to the script rather than reading it itself.
				// The aggregator gets the flag too — it forwards `--reporter` to each child it spawns, which
				// is the only way a whole-workspace run gets quiet ( see scripts/test-all.mjs ).
				const quiet = !verbose && ( target.runner === 'vitest' || target.runner === 'aggregator' );
				const argv  = quiet ? [ 'run', target.script, '--', '--reporter=dot' ] : [ 'run', target.script ];

				const started = Date.now();
				const run = spawnSync( 'npm', argv, {
					cwd:      target.cwd,
					shell:    true,
					encoding: 'utf8',
					timeout:  timeoutMs,
					// Suites are chatty; a truncated tail loses the failures, which are the only part that
					// matters. 20MB is far above any real run and far below anything that hurts.
					maxBuffer: 20 * 1024 * 1024
				} );

				const outcome    = run.error ? 'did-not-complete' : run.status === 0 ? 'passed' : 'failed';
				const command    = `npm ${ argv.join( ' ' ) }`;
				const durationMs = Date.now() - started;

				// The report, as one document: what was run at the top, then each stream under its own
				// banner. The banners are there so a grep hit can be placed — vitest writes its summary to
				// stdout and a crashing worker writes to stderr, and a reader who cannot tell which they are
				// looking at will draw the wrong conclusion from the same words.
				const body = [
					`# ${ target.name } — ${ outcome }`,
					`command    ${ command }`,
					`cwd        ${ target.cwd }`,
					`reporter   ${ quiet ? 'dot' : 'default' }`,
					`exit       ${ run.status }`,
					`duration   ${ durationMs }ms`,
					`takenAt    ${ new Date().toISOString() }`,
					'',
					'── stdout ──',
					run.stdout ?? '',
					'── stderr ──',
					run.stderr ?? ''
				].join( '\n' );

				// Written before anything is returned, and its failure REPORTED rather than thrown: a run
				// that happened and could not be filed is still a run whose tail is worth having, and an
				// exception here would throw away the one copy of it that exists.
				const file = join( root, 'testresults', target.name.replace( /[^A-Za-z0-9._-]+/g, '-' ) + '.txt' );
				let report:      string | null = null;
				let reportError: string | null = null;
				try {
					mkdirSync( join( root, 'testresults' ), { recursive: true } );
					writeFileSync( file, body, 'utf8' );
					report = relative( root, file ).replaceAll( '\\', '/' );
				} catch ( e ) {
					reportError = e instanceof Error ? e.message : String( e );
				}

				return ok( {
					suite:      target.name,
					// The command AS RUN, reporter flag included — a caller reproducing this by hand should be
					// typing the same line, and a quieted run that reported the bare script would send them to
					// a different-looking result.
					command,
					reporter:   quiet ? 'dot' : 'default',
					cwd:        relative( root, target.cwd ).replaceAll( '\\', '/' ) || '.',
					exitCode:   run.status,
					// Three different endings that a bare exit code would flatten into one: finished green,
					// finished red, and never finished at all.
					outcome,
					timedOut:   run.error?.message?.includes( 'ETIMEDOUT' ) ?? false,
					durationMs,
					// WHERE THE WHOLE RUN IS, relative to the workspace root — grep it, don't ask for it again.
					report,
					reportError,
					reportBytes: body.length,
					// THE END OF THE OUTPUT, verbatim, because that is where vitest prints both its failures
					// and its summary. A slice, not a selection: nothing here decides which lines matter.
					tail:       body.length > TAIL_CHARS ? body.slice( -TAIL_CHARS ) : body,
					tailIsWhole: body.length <= TAIL_CHARS
				} );
			}
		}

	];
}

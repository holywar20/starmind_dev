import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';

import { condense, deriveWarnings, serialiseResults, type ReporterJson } from '../TestReport';
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

/** One suite, resolved: where to run, what to run, and whether the runner understands vitest's flags. */
interface SuiteTarget { cwd: string; script: string; name: string; runner: 'vitest' | 'aggregator' | 'other' }

/**
 * Where one suite's artifacts live.
 *
 * DERIVED FROM THE SUITE NAME, which is what makes the whole-workspace case safe. Every path here is
 * a function of `name`, so two sub-projects cannot land on one file — the collision the aggregator
 * trap is about is not avoided by care, it is unreachable.
 */
export function artifactPaths( root: string, name: string ) {
	const safe = name.replace( /[^A-Za-z0-9._-]+/g, '-' );
	const dir  = join( root, 'testresults' );
	return {
		dir,
		safe,
		txt:      join( dir, `${ safe }.txt` ),
		results:  join( dir, `${ safe }.results.json` ),
		errors:   join( dir, `${ safe }.errors.json` ),
		warnings: join( dir, `${ safe }.warnings.json` ),
		// The reporter's OWN dump — megabytes for a large suite, and an intermediate rather than a
		// product. Under a dot directory so a person opening testresults/ does not meet it, and removed
		// once it has been condensed.
		raw:      join( dir, '.raw', `${ safe }.vitest.json` )
	};
}

/** Run ONE suite and file everything it produced. The unit both the single-suite and whole-workspace
 *  paths are built from, so the two cannot drift in what they write or what they report. */
function runOne( root: string, target: SuiteTarget, timeoutMs: number, verbose: boolean ) {
	const paths = artifactPaths( root, target.name );
	try { mkdirSync( join( paths.dir, '.raw' ), { recursive: true } ); } catch { /* reported below */ }

	// A STALE DUMP IS THE ONE WAY THIS LIES. If the run dies before the reporter writes, last run's
	// file is still sitting there and would be condensed as though it were this run's. Removed first,
	// so an absent dump reads as absent.
	try { if ( existsSync( paths.raw ) ) unlinkSync( paths.raw ); } catch { /* the read below copes */ }

	// `--` FIRST: npm hands everything after it to the script rather than reading it itself. Two
	// reporters in ONE execution — the human render to the terminal, the machine record to its own
	// file — which is why nothing downstream has to scrape text back into structure. Offered only to a
	// runner that provably understands the flags; appending them to a stranger's runner would turn
	// "structured" into "broken".
	// An AGGREGATOR takes the render reporter and NOT the json one: it forwards a flag to every child it
	// spawns, so one `--outputFile.json` would have each sub-project overwrite the same file and the
	// record would be whichever child finished last. Structured results are produced per sub-project,
	// where the path is a function of the name and a collision is unreachable.
	const quiet   = !verbose && ( target.runner === 'vitest' || target.runner === 'aggregator' );
	const render  = verbose ? [] : [ '--reporter=dot' ];
	const outFlag = `--outputFile.json="${ paths.raw.replaceAll( '\\', '/' ) }"`;
	const flags   =
		  target.runner === 'vitest'     ? [ verbose ? '--reporter=default' : '--reporter=dot', '--reporter=json', outFlag ]
		: target.runner === 'aggregator' ? render
		: [];
	const argv    = flags.length ? [ 'run', target.script, '--', ...flags ] : [ 'run', target.script ];
	const asksJson = flags.includes( '--reporter=json' );

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
	const stdout     = run.stdout ?? '';
	const stderr     = run.stderr ?? '';

	// The report, as one document: what was run at the top, then each stream under its own banner. The
	// banners are there so a grep hit can be placed — vitest writes its summary to stdout and a
	// crashing worker writes to stderr, and a reader who cannot tell which they are looking at will
	// draw the wrong conclusion from the same words.
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
		stdout,
		'── stderr ──',
		stderr
	].join( '\n' );

	// Written before anything is returned, and its failure REPORTED rather than thrown: a run that
	// happened and could not be filed is still a run whose tail is worth having, and an exception here
	// would throw away the one copy of it that exists.
	let report:      string | null = null;
	let reportError: string | null = null;
	try {
		mkdirSync( paths.dir, { recursive: true } );
		writeFileSync( paths.txt, body, 'utf8' );
		report = relative( root, paths.txt ).replaceAll( '\\', '/' );
	} catch ( e ) {
		reportError = e instanceof Error ? e.message : String( e );
	}

	// ── The structured half ───────────────────────────────────────────────────
	const here = ( p: string ): string => relative( root, p ).replaceAll( '\\', '/' );
	const structured: {
		results: string | null; resultsBytes: number; errors: string | null; warnings: string | null;
		totals: Record<string, number> | null; warningLines: number; structuredError: string | null;
	} = { results: null, resultsBytes: 0, errors: null, warnings: null, totals: null, warningLines: 0, structuredError: null };

	if ( asksJson ) {
		try {
			// An ABSENT dump is not a failure of this code — it is what a crashed or timed-out run looks
			// like. Said in those words rather than folded into a generic error.
			if ( !existsSync( paths.raw ) ) {
				structured.structuredError = outcome === 'did-not-complete'
					? 'The run did not complete, so vitest wrote no JSON report. The verbatim .txt is the only record.'
					: 'vitest wrote no JSON report at the requested path. The verbatim .txt is unaffected.';
			}
			else {
				const raw = JSON.parse( readFileSync( paths.raw, 'utf8' ) ) as ReporterJson;
				const { results, errors } = condense( raw, target.name, target.cwd, outcome );

				const resultsText = serialiseResults( results );
				writeFileSync( paths.results, resultsText, 'utf8' );
				writeFileSync( paths.errors, JSON.stringify( errors, null, 2 ) + '\n', 'utf8' );

				const warnings = deriveWarnings( target.name, stdout, stderr );
				writeFileSync( paths.warnings, JSON.stringify( warnings, null, 2 ) + '\n', 'utf8' );

				structured.results      = here( paths.results );
				structured.resultsBytes = resultsText.length;
				structured.errors       = here( paths.errors );
				structured.warnings     = here( paths.warnings );
				structured.totals       = results.totals;
				structured.warningLines = warnings.lines.length;

				// Only once the condensed form exists on disk. Deleting first would trade a huge readable
				// artifact for nothing at all if the write below it failed.
				try { unlinkSync( paths.raw ); } catch { /* an orphan dump is untidy, not wrong */ }
			}
		} catch ( e ) {
			structured.structuredError = e instanceof Error ? e.message : String( e );
		}
	}
	else {
		structured.structuredError = target.runner === 'aggregator'
			? 'An aggregator forwards one output path to every child, so structured results are not asked for here. Run a sub-project by name for its own artifacts.'
			: `"${ target.name }" is not run by vitest, so there is no JSON reporter to ask. Text only.`;
	}

	return {
		suite:      target.name,
		// The command AS RUN, reporter flags included — a caller reproducing this by hand should be
		// typing the same line, and a quieted run that reported the bare script would send them to a
		// different-looking result.
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
		...structured,
		// THE END OF THE OUTPUT, verbatim, because that is where vitest prints both its failures and its
		// summary. A slice, not a selection: nothing here decides which lines matter.
		tail:       body.length > TAIL_CHARS ? body.slice( -TAIL_CHARS ) : body,
		tailIsWhole: body.length <= TAIL_CHARS
	};
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
			description: 'Run one sub-project\'s test suite, or the whole workspace. Writes the whole run to `testresults/<suite>.txt` under the workspace root, plus machine-readable `<suite>.results.json` / `.errors.json` / `.warnings.json` beside it, and returns the verdict plus the tail of the output.',
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
				'the run verbatim, and the tail is a literal slice of its end.\n\n' +
				'STRUCTURED RESULTS COME OUT OF THE SAME RUN ( 2026-09-29 ). Vitest takes several reporters in ' +
				'ONE execution, so the call asks for the render AND `--reporter=json --outputFile.json=<path>` ' +
				'together. Nothing is scraped: `<suite>.results.json` is keyed on full test name and carries ' +
				'[ status, durationMs, file index ] against a `files` array, so a sub-project\'s paths are ' +
				'stored once rather than once per test; `<suite>.errors.json` carries the failures with their ' +
				'messages and a `fileLevel` list for suites that died before asserting anything. The reporter\'s ' +
				'own dump is an intermediate and is deleted once condensed. `resultsBytes` rides the answer — ' +
				'a five-thousand-test suite\'s keyed file is a few hundred KB and is meant to be grepped, not ' +
				'returned whole.\n\n' +
				'`<suite>.warnings.json` IS NOT NATIVE and says so on its own face. Vitest\'s JSON reporter ' +
				'models test OUTCOMES and has no console channel, so warn-level output can only come from the ' +
				'captured streams. It is a literal line match with no taxonomy applied, and a test that ' +
				'deliberately provokes a warning appears in it.\n\n' +
				'`suite: "all"` AGGREGATES HERE. There is no root `test:all` script in this workspace ( and no ' +
				'root package.json ), so the old whole-workspace path could never have run. This tool now runs ' +
				'each runnable sub-project in turn, each writing its own artifacts — `timeoutMs` applies per ' +
				'sub-project, and `testresults/all.txt` is an index naming the per-suite files rather than a ' +
				'copy of them.\n\n' +
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

				// WHAT THE SCRIPT ACTUALLY RUNS, read off the package rather than assumed. The reporter
				// flags are vitest's, and a sub-project is free to test with something else — so they are
				// offered only where the command provably understands them. A tool that appended a foreign
				// flag to a stranger's runner would turn "structured" into "broken".
				const asTarget = ( p: { dir: string; name: string; pkg: Record<string, unknown> | null; script: string } ): SuiteTarget => {
					const scripts = ( p.pkg?.[ 'scripts' ] ?? {} ) as Record<string, string>;
					return {
						cwd:    p.dir,
						script: p.script,
						name:   p.name,
						runner: /\bvitest\b/.test( scripts[ p.script ] ?? '' ) ? 'vitest' : 'other'
					};
				};

				if ( suite === 'all' ) {
					// THE ROOT AGGREGATOR DOES NOT EXIST. This tool has always run `npm run test:all` at the
					// workspace root; checked on 2026-09-29, there is no package.json there at all and
					// `scripts/` is empty, so that call has been failing on its first line for as long as it
					// has been here. The branch is kept because a returning aggregator is the thing a person
					// would run by hand — but it is no longer the ONLY way to ask for the whole workspace.
					const rootScripts = ( Workspace.packageJson( root )?.[ 'scripts' ] ?? {} ) as Record<string, string>;
					if ( rootScripts[ 'test:all' ] ) {
						return ok( runOne( root, { cwd: root, script: 'test:all', name: 'all', runner: 'aggregator' }, timeoutMs, verbose ) );
					}

					// Otherwise this tool aggregates: each runnable sub-project, each with its OWN artifact
					// paths, because every path is derived from the suite name. The overwrite trap an
					// aggregator's forwarded `--outputFile.json` sets is not avoided here, it is unreachable.
					const targets = available.flatMap( ( p ) => p.script ? [ asTarget( { ...p, script: p.script } ) ] : [] );
					const started = Date.now();
					const runs    = targets.map( ( t ) => runOne( root, t, timeoutMs, verbose ) );

					// An INDEX, not a concatenation. The per-suite files are the record; copying them into a
					// fourth file would give two answers that drift the moment one suite is re-run alone.
					const index = [
						`# all — ${ runs.every( ( r ) => r.outcome === 'passed' ) ? 'passed' : 'failed' }`,
						`aggregated by run_suite ( no root test:all script exists )`,
						`takenAt    ${ new Date().toISOString() }`,
						'',
						...runs.map( ( r ) => `${ r.outcome.padEnd( 17 ) } ${ r.suite.padEnd( 20 ) } ${ r.durationMs }ms  → ${ r.report ?? 'unfiled' }` )
					].join( '\n' ) + '\n';
					let indexPath: string | null = null;
					try {
						writeFileSync( artifactPaths( root, 'all' ).txt, index, 'utf8' );
						indexPath = 'testresults/all.txt';
					} catch { /* the per-suite files are the record; the index is a convenience */ }

					return ok( {
						suite:      'all',
						aggregatedBy: 'run_suite',
						note: 'There is no root `test:all` script and no `scripts/` content in this workspace, so the ' +
						      'previous whole-workspace path could never have run. This call ran each runnable ' +
						      'sub-project in turn, each writing its own artifacts under testresults/.',
						outcome:    runs.every( ( r ) => r.outcome === 'passed' ) ? 'passed' : 'failed',
						durationMs: Date.now() - started,
						timeoutNote: `\`timeoutMs\` ( ${ timeoutMs }ms ) applies PER SUB-PROJECT, not to the whole set.`,
						report:     indexPath,
						// Per suite, and deliberately without each one's tail — four tails is the overflow this
						// tool writes to disk to avoid. Open the named .txt for any suite that went red.
						suites: runs.map( ( r ) => ( {
							suite: r.suite, outcome: r.outcome, exitCode: r.exitCode, durationMs: r.durationMs,
							report: r.report, results: r.results, resultsBytes: r.resultsBytes,
							errors: r.errors, warnings: r.warnings, totals: r.totals ?? null,
							structuredError: r.structuredError
						} ) )
					} );
				}

				const found = available.find( ( p ) => p.name === suite || basename( p.dir ) === suite );
				if ( !found )        return fail( `No sub-project named "${ suite }". Call run_suite with no arguments to list them.` );
				if ( !found.script ) return fail( `"${ found.name }" has no test or verify script — there is nothing to run. This is a fact about the sub-project, not a failure of this call.` );

				return ok( runOne( root, asTarget( { ...found, script: found.script } ), timeoutMs, verbose ) );
			}
		}

	];
}

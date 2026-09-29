/**
 * TestReport — the structured half of a test run.
 *
 * `run_suite` has always written the run VERBATIM to `testresults/<suite>.txt`, and that file stays
 * exactly as it was: it is the record of what actually printed, and its reasons are documented on the
 * tool. What it is not is readable by a program. A caller wanting "which tests failed" had to grep
 * prose, and a caller wanting "how long does this one take" had no answer at all.
 *
 * SO THE STRUCTURE COMES FROM THE RUNNER, NOT FROM THE TEXT. Vitest takes several reporters in ONE
 * execution, each with its own target — `--reporter=dot --reporter=json --outputFile.json=<path>` —
 * so the human render and the machine record are two outputs of the same run rather than one scraped
 * back out of the other. Nothing in this file parses console output to learn a test's outcome; it
 * reads the reporter's own object. That distinction is the whole point of doing it this way: a
 * scraper is wrong the first time a message contains the word "failed".
 *
 * THE ONE PLACE THAT IS NOT NATIVE is warnings. Vitest's JSON reporter models test OUTCOMES and has
 * no console channel in it, so warn-level output can only come from the captured streams. That half
 * is a deliberately dumb line matcher, and it says on the artifact that it is one.
 */

/** The Jest-shaped object vitest's `json` reporter writes. Only the fields actually read are named —
 *  this is a view of the reporter's output, not a mirror of it, and a mirror would go stale. */
export interface ReporterJson {
	numTotalTests?:  number;
	numPassedTests?: number;
	numFailedTests?: number;
	numPendingTests?: number;
	numTodoTests?:   number;
	success?:        boolean;
	startTime?:      number;
	testResults?: Array<{
		name?:      string;
		status?:    string;
		message?:   string;
		startTime?: number;
		endTime?:   number;
		assertionResults?: Array<{
			fullName?:        string;
			title?:           string;
			status?:          string;
			duration?:        number | null;
			failureMessages?: string[] | null;
			location?:        { line: number; column: number } | null;
		}>;
	}>;
}

/** One test, as the keyed file stores it: [ status, ms, fileIndex ]. */
export type TestRow = [ string, number, number ];

export interface ResultsFile {
	suite:   string;
	takenAt: string;
	outcome: string;
	legend:  string;
	totals:  Record<string, number>;
	/** Every test file once, in the order first seen. A row's third element indexes THIS. */
	files:   string[];
	/** Full test name → row. The whole reason this file is small: 288 paths stored once, not 5450 times. */
	tests:   Record<string, TestRow>;
}

export interface ErrorRow {
	name:     string;
	file:     string;
	line:     number | null;
	messages: string[];
}

export interface ErrorsFile {
	suite:    string;
	takenAt:  string;
	outcome:  string;
	failed:   number;
	/** A file whose suite never ran — an import throw, a config fault — fails no assertion, so it would
	 *  vanish from an assertion-only reading. It is the failure most worth not losing. */
	fileLevel: Array<{ file: string; message: string }>;
	failures: ErrorRow[];
}

/** Status letters. A single character because it is repeated once per test and the legend rides the file. */
const LETTER: Record<string, string> = {
	passed:  'P',
	failed:  'F',
	skipped: 'S',
	pending: 'S',
	todo:    'T',
	disabled: 'S'
};

export const LEGEND = 'tests: { "<full test name>": [ status, durationMs, index into files[] ] }. ' +
	'status: P passed · F failed · S skipped · T todo · ? unknown.';

/** Paths as the workspace says them — forward slashes, and relative to the sub-project when possible.
 *  An absolute Windows path repeated 288 times is both noise and a machine-specific detail in a file
 *  somebody may well commit. */
function tidyPath( abs: string, cwd: string ): string {
	const a = abs.replaceAll( '\\', '/' );
	const c = cwd.replaceAll( '\\', '/' ).replace( /\/$/, '' );
	return a.toLowerCase().startsWith( c.toLowerCase() + '/' ) ? a.slice( c.length + 1 ) : a;
}

/**
 * Turn one reporter dump into the two structured artifacts.
 *
 * `outcome` comes from the CALLER, not from the dump: a run that never completed — a timeout, a
 * crashed worker — writes no reporter file at all or writes a partial one, and inferring "passed"
 * from an absent failure count is exactly the silent lie this whole task exists to remove.
 */
export function condense( raw: ReporterJson, suite: string, cwd: string, outcome: string ): { results: ResultsFile; errors: ErrorsFile } {
	const takenAt = new Date().toISOString();

	const files:   string[]              = [];
	const tests:   Record<string, TestRow> = {};
	const failures: ErrorRow[]           = [];
	const fileLevel: Array<{ file: string; message: string }> = [];

	let collisions = 0;

	for ( const suiteFile of raw.testResults ?? [] ) {
		const path  = tidyPath( suiteFile.name ?? '<unknown>', cwd );
		const index = files.push( path ) - 1;

		// A suite that failed as a WHOLE — it threw on import, or its setup died. `message` carries the
		// reason and there are no assertions under it to carry one instead.
		if ( suiteFile.status === 'failed' && ( suiteFile.assertionResults ?? [] ).length === 0 ) {
			fileLevel.push( { file: path, message: ( suiteFile.message ?? '' ).trim() || 'failed with no message' } );
		}

		for ( const test of suiteFile.assertionResults ?? [] ) {
			const name   = test.fullName ?? test.title ?? '<unnamed>';
			const letter = LETTER[ test.status ?? '' ] ?? '?';

			// Two tests CAN share a full name across two files, and a map silently keeps the last. Say so
			// with a count rather than pretending the totals add up — a keyed file that quietly drops rows
			// is worse than one that admits it dropped some.
			if ( name in tests ) collisions++;

			tests[ name ] = [ letter, Math.round( test.duration ?? 0 ), index ];

			if ( letter === 'F' ) {
				failures.push( {
					name,
					file:     path,
					line:     test.location?.line ?? null,
					messages: test.failureMessages ?? []
				} );
			}
		}
	}

	const totals: Record<string, number> = {
		tests:     raw.numTotalTests   ?? Object.keys( tests ).length,
		passed:    raw.numPassedTests  ?? 0,
		failed:    raw.numFailedTests  ?? 0,
		skipped:   raw.numPendingTests ?? 0,
		todo:      raw.numTodoTests    ?? 0,
		files:     files.length,
		keyed:     Object.keys( tests ).length,
		nameCollisions: collisions
	};

	return {
		results: { suite, takenAt, outcome, legend: LEGEND, totals, files, tests },
		errors:  { suite, takenAt, outcome, failed: failures.length, fileLevel, failures }
	};
}

/**
 * The keyed file, serialised ONE ROW PER LINE.
 *
 * `JSON.stringify( x, null, 2 )` would put a keyed file of five thousand tests on twenty thousand
 * lines, and `JSON.stringify( x )` would put it on one. Neither is greppable. So the rows are written
 * by hand — still valid JSON, one test per line, which is the form a human scans and a grep answers.
 */
export function serialiseResults( r: ResultsFile ): string {
	const head = [
		`  "suite": ${ JSON.stringify( r.suite ) },`,
		`  "takenAt": ${ JSON.stringify( r.takenAt ) },`,
		`  "outcome": ${ JSON.stringify( r.outcome ) },`,
		`  "legend": ${ JSON.stringify( r.legend ) },`,
		`  "totals": ${ JSON.stringify( r.totals ) },`,
		`  "files": [`,
		r.files.map( ( f ) => `    ${ JSON.stringify( f ) }` ).join( ',\n' ),
		`  ],`,
		`  "tests": {`
	];

	const rows = Object.entries( r.tests )
		.map( ( [ name, row ] ) => `    ${ JSON.stringify( name ) }: ${ JSON.stringify( row ) }` )
		.join( ',\n' );

	return [ '{', ...head, rows, '  }', '}' ].join( '\n' ) + '\n';
}

// ── Warnings: the one non-native half ─────────────────────────────────────────

export interface WarningRow {
	stream: 'stdout' | 'stderr';
	/** The test file vitest attributed the output to, when its banner named one. */
	from:   string | null;
	line:   string;
}

export interface WarningsFile {
	suite:   string;
	takenAt: string;
	derivedFrom: string;
	caveat:  string;
	counted: Record<string, number>;
	lines:   WarningRow[];
}

/** ANSI is decoration, and every banner in a vitest run is wrapped in it. Stripped before matching so
 *  the matcher is looking at the words rather than at the colour codes between them. */
export function stripAnsi( s: string ): string {
	// eslint-disable-next-line no-control-regex
	return s.replace( /\u001b\[[0-9;]*m/g, '' );
}

/** Lines that read as warn-level. DELIBERATELY DUMB and deliberately short: no taxonomy, no severity
 *  ranking, no attempt to group. Each entry is a real line from a real stream, and anything cleverer
 *  would be this tool inventing a judgment it is not entitled to make. */
// NO WORD BOUNDARIES, on purpose: the single most wanted line is `DeprecationWarning:`, and a \b
// before "warn" cannot see it. A substring match takes a few false positives in exchange, which is
// the right trade for an artifact that promises only "this printed".
const WARNY = /warn|deprecat|experimental/i;

/**
 * Derive the warnings artifact from the captured streams.
 *
 * Vitest banners console output as `stdout | <file> > <test name>` and prints the message on the lines
 * beneath, so a matching line can usually be attributed to a file. A line with no banner above it is
 * recorded with `from: null` rather than guessed at.
 */
export function deriveWarnings( suite: string, stdout: string, stderr: string ): WarningsFile {
	const lines: WarningRow[] = [];
	let stdoutLines = 0, stderrLines = 0, consoleLines = 0;

	const scan = ( text: string, stream: 'stdout' | 'stderr' ): number => {
		let from: string | null = null;
		const all = stripAnsi( text ).split( /\r?\n/ );

		for ( const line of all ) {
			const banner = /^(stdout|stderr)\s*\|\s*([^\s>]+)/.exec( line );
			if ( banner ) { from = banner[ 2 ] ?? null; consoleLines += 1; continue; }
			if ( line.trim() === '' ) continue;
			if ( !WARNY.test( line ) ) continue;
			lines.push( { stream, from, line: line.trim().slice( 0, 500 ) } );
		}
		return all.length;
	};

	stdoutLines = scan( stdout, 'stdout' );
	stderrLines = scan( stderr, 'stderr' );

	const counted: Record<string, number> = { stdoutLines, stderrLines, consoleLines, matched: lines.length };

	return {
		suite,
		takenAt: new Date().toISOString(),
		derivedFrom: 'captured stdout/stderr — NOT the JSON reporter',
		caveat: 'Vitest\'s JSON reporter models test outcomes and carries no console channel, so this file ' +
		        'cannot be native. It is a literal line match on warn/warning/deprecated/experimental, with ' +
		        'no taxonomy applied. A test that deliberately provokes a warning appears here too; this ' +
		        'file reports what printed, not what is wrong.',
		counted,
		lines
	};
}

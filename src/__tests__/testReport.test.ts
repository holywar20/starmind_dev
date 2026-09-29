import { describe, expect, it } from 'vitest';

import { condense, deriveWarnings, serialiseResults, type ReporterJson } from '../TestReport';

/**
 * The condenser is the half of `run_suite` that can be tested without spawning anything — which is
 * exactly why it is a module rather than a closure inside the handler. These assert the two properties
 * that actually matter downstream: the keyed file stays small, and a failure keeps its message.
 */

const CWD = 'C:\\ws\\starmind';

function dump(): ReporterJson {
	return {
		numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, success: false,
		testResults: [
			{
				name: 'C:\\ws\\starmind\\src\\a.test.ts', status: 'failed',
				assertionResults: [
					{ fullName: 'A > passes', status: 'passed', duration: 4.6, failureMessages: [] },
					{ fullName: 'A > breaks', status: 'failed', duration: 9, failureMessages: [ 'expected 1 to be 2' ], location: { line: 12, column: 3 } }
				]
			},
			{
				name: 'C:\\ws\\starmind\\src\\b.test.ts', status: 'passed',
				assertionResults: [ { fullName: 'B > skipped one', status: 'skipped', duration: null, failureMessages: null } ]
			}
		]
	};
}

describe( 'condense — the reporter dump to the keyed record', () => {

	it( 'keys on full test name and stores each file path ONCE', () => {
		const { results } = condense( dump(), 'starmind', CWD, 'failed' );

		expect( results.files ).toEqual( [ 'src/a.test.ts', 'src/b.test.ts' ] );
		// The third element indexes files[] — that indirection is the whole size argument.
		expect( results.tests[ 'A > passes' ] ).toEqual( [ 'P', 5, 0 ] );
		expect( results.tests[ 'B > skipped one' ] ).toEqual( [ 'S', 0, 1 ] );
	} );

	it( 'takes its outcome from the CALLER, not from the dump', () => {
		// A run that never finished can still leave a dump whose counters read green.
		const { results } = condense( dump(), 'starmind', CWD, 'did-not-complete' );
		expect( results.outcome ).toBe( 'did-not-complete' );
	} );

	it( 'carries a failure with its message, its file and its line', () => {
		const { errors } = condense( dump(), 'starmind', CWD, 'failed' );

		expect( errors.failed ).toBe( 1 );
		expect( errors.failures[ 0 ] ).toMatchObject( {
			name: 'A > breaks', file: 'src/a.test.ts', line: 12, messages: [ 'expected 1 to be 2' ]
		} );
	} );

	it( 'keeps a suite that died before asserting anything, which an assertion-only reading would lose', () => {
		const raw: ReporterJson = { testResults: [
			{ name: 'C:\\ws\\starmind\\src\\c.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] }
		] };
		const { errors } = condense( raw, 'starmind', CWD, 'failed' );

		expect( errors.failures ).toHaveLength( 0 );
		expect( errors.fileLevel ).toEqual( [ { file: 'src/c.test.ts', message: 'Cannot find module' } ] );
	} );

	it( 'counts a name collision rather than silently dropping the row', () => {
		const raw: ReporterJson = { testResults: [
			{ name: 'C:\\ws\\starmind\\a.test.ts', assertionResults: [ { fullName: 'same', status: 'passed' } ] },
			{ name: 'C:\\ws\\starmind\\b.test.ts', assertionResults: [ { fullName: 'same', status: 'passed' } ] }
		] };
		const { results } = condense( raw, 'starmind', CWD, 'passed' );

		expect( results.totals[ 'nameCollisions' ] ).toBe( 1 );
		expect( results.totals[ 'keyed' ] ).toBe( 1 );
	} );

} );

describe( 'serialiseResults — valid JSON, one test per line', () => {

	it( 'round-trips and puts exactly one test on each line', () => {
		const { results } = condense( dump(), 'starmind', CWD, 'failed' );
		const text = serialiseResults( results );

		expect( JSON.parse( text ) ).toMatchObject( { suite: 'starmind', tests: results.tests } );
		// Greppability is the requirement: one row, one line.
		expect( text.split( '\n' ).filter( ( l ) => l.includes( '"A > breaks"' ) ) ).toHaveLength( 1 );
	} );

} );

describe( 'deriveWarnings — the one non-native artifact', () => {

	it( 'attributes a warn line to the file its banner named', () => {
		const stderr = [
			'stderr | src/x.test.ts > something',
			'[Store] WARN partition missing',
			'',
			'stderr | src/y.test.ts > other',
			'all fine here'
		].join( '\n' );

		const w = deriveWarnings( 'starmind', '', stderr );

		expect( w.lines ).toEqual( [ { stream: 'stderr', from: 'src/x.test.ts', line: '[Store] WARN partition missing' } ] );
		expect( w.counted[ 'consoleLines' ] ).toBe( 2 );
	} );

	it( 'reports a line with no banner above it as unattributed rather than guessing', () => {
		const w = deriveWarnings( 'starmind', 'DeprecationWarning: something', '' );
		expect( w.lines[ 0 ] ).toMatchObject( { from: null, stream: 'stdout' } );
	} );

} );

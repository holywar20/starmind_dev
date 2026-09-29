import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { artifactPaths, coldTools } from '../tools/cold';
import { Workspace } from '../Workspace';

/**
 * THE OVERWRITE TRAP, guarded against a real run.
 *
 * `--outputFile.json` names ONE path. A whole-workspace run that passed a single one down to every
 * sub-project would have each child write the same file and the record would be whichever finished
 * last — a failure that looks perfect in a single-suite test and is silently wrong in the real case.
 * So it is tested where it actually happens: two genuine vitest sub-projects, run through `suite:
 * "all"`, and their two results files read back and compared.
 *
 * The fixture workspace lives INSIDE this package on purpose — `npm run` puts every ancestor
 * `node_modules/.bin` on PATH, so a bare `vitest` in a sub-project two levels down resolves to this
 * package's own copy without an install. It sits outside `src/`, so this suite's own `include` does
 * not collect the fixture's tests.
 */

const FIXTURE = resolve( __dirname, '..', '..', '.tmp-aggregate' );
const SUITES  = [ 'alpha', 'beta' ];

function writeSubProject( name: string, tests: number ): void {
	const dir = join( FIXTURE, name );
	// `src/`, because vitest WALKS UP for a config when a project has none and finds this package's,
	// whose `include` is `src/**/*.test.ts`. A fixture test anywhere else is collected by nothing and
	// the run exits 1 with "No test files found".
	mkdirSync( join( dir, 'src' ), { recursive: true } );
	writeFileSync( join( dir, 'package.json' ), JSON.stringify( { name, private: true, scripts: { test: 'vitest run' } } ), 'utf8' );
	// A different test COUNT per sub-project is the whole assertion: if one file overwrote the other,
	// the counts would agree.
	const body = [ `import { it, expect } from 'vitest';` ]
		.concat( Array.from( { length: tests }, ( _, i ) => `it( '${ name } case ${ i }', () => { expect( ${ i } ).toBe( ${ i } ); } );` ) )
		.join( '\n' );
	writeFileSync( join( dir, 'src', `${ name }.test.ts` ), body, 'utf8' );
}

describe( 'run_suite `all` — every sub-project gets its own output path', () => {

	let before: string | undefined;

	beforeAll( () => {
		before = process.env[ 'STARMIND_DEV_ROOT' ];
		mkdirSync( join( FIXTURE, '_Claude' ), { recursive: true } );
		mkdirSync( join( FIXTURE, 'scripts' ), { recursive: true } );
		writeSubProject( 'alpha', 2 );
		writeSubProject( 'beta', 5 );
		process.env[ 'STARMIND_DEV_ROOT' ] = FIXTURE;
		Workspace.reset();
	} );

	afterAll( () => {
		if ( before === undefined ) delete process.env[ 'STARMIND_DEV_ROOT' ];
		else process.env[ 'STARMIND_DEV_ROOT' ] = before;
		Workspace.reset();
		rmSync( FIXTURE, { recursive: true, force: true } );
	} );

	it( 'derives every artifact path from the suite name, so two suites cannot collide', () => {
		const a = artifactPaths( FIXTURE, 'alpha' );
		const b = artifactPaths( FIXTURE, 'beta' );
		const overlap = Object.values( a ).filter( ( p ) => Object.values( b ).includes( p ) );
		expect( overlap ).toEqual( [ join( FIXTURE, 'testresults' ), ] );
	} );

	it( 'runs both sub-projects and keeps their results files apart', async () => {
		const tool = coldTools().find( ( t ) => t.name === 'run_suite' )!;
		const out  = JSON.parse( ( await tool.handler( { suite: 'all' } ) ).content[ 0 ]!.text ) as Record<string, unknown>;

		expect( out[ 'suite' ] ).toBe( 'all' );
		expect( out[ 'aggregatedBy' ] ).toBe( 'run_suite' );
		expect( out[ 'outcome' ] ).toBe( 'passed' );

		const suites = out[ 'suites' ] as Array<Record<string, unknown>>;
		expect( suites.map( ( s ) => s[ 'suite' ] ).sort() ).toEqual( SUITES );

		// Two DISTINCT paths, and two files that disagree about how many tests ran — which they could
		// not do if one had overwritten the other.
		const paths = suites.map( ( s ) => s[ 'results' ] as string );
		expect( new Set( paths ).size ).toBe( 2 );

		const counts: Record<string, number> = {};
		for ( const s of suites ) {
			const file = join( FIXTURE, s[ 'results' ] as string );
			expect( existsSync( file ) ).toBe( true );
			const doc = JSON.parse( readFileSync( file, 'utf8' ) ) as { suite: string; totals: Record<string, number> };
			expect( doc.suite ).toBe( s[ 'suite' ] );
			counts[ doc.suite ] = doc.totals[ 'tests' ]!;
		}
		expect( counts ).toEqual( { alpha: 2, beta: 5 } );

		// And the index names them rather than copying them.
		const index = readFileSync( join( FIXTURE, 'testresults', 'all.txt' ), 'utf8' );
		for ( const name of SUITES ) expect( index ).toContain( `testresults/${ name }.txt` );
	}, 120_000 );

} );

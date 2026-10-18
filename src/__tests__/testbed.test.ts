import { describe, it, expect } from 'vitest';

import { Testbed, fenceOutcome, type Manifest } from '../tools/testbed';

/** A manifest with one plain lane and one chained lane — the two shapes `tasksOf` has to read. */
function manifest(): Manifest {
	return {
		projectId: 'tidepool-testbed',
		agent:     { name: 'Subject', model: 'remote.gb10-laguna', tools: [ 'sm_file.read', 'sm_board.ask' ] },
		reach:     [ { path: 'sandbox/read', level: 'read' } ],
		lanes:     [
			{
				id: 'tbit-inside', name: 'inside', sessionPolicy: 'resident', reemitLimit: 1,
				tasks: [
					{ slug: 'first', title: 'First', body: 'Read {sandbox}/read/ledger.csv.', exitCondition: 'Done.', step: '3.a' },
					{ slug: 'second', title: 'Second', body: 'Then this.', exitCondition: 'Done.', step: '3.b', blockedBy: [ 'first' ], approval: 'human' }
				]
			},
			{
				id: 'tbit-long-run', name: 'long-run', sessionPolicy: 'resident', reemitLimit: 1,
				chain: { count: 3, slug: 'journal-{n}', title: 'Entry {n}', body: 'Add entry {n}.', exitCondition: 'At least {n}.', step: '5.d-{nn}' }
			}
		]
	};
}

describe( 'the test bed manifest', () => {

	it( 'expands a chain into numbered steps, each held on the one before', () => {
		const chain = Testbed.tasksOf( manifest() ).filter( ( t ) => t.lane.id === 'tbit-long-run' ).map( ( t ) => t.task );

		expect( chain.map( ( t ) => t.slug ) ).toEqual( [ 'journal-1', 'journal-2', 'journal-3' ] );
		expect( chain.map( ( t ) => t.step ) ).toEqual( [ '5.d-01', '5.d-02', '5.d-03' ] );
		expect( chain[ 0 ].blockedBy ).toBeUndefined();
		expect( chain[ 2 ].blockedBy ).toEqual( [ 'journal-2' ] );
		expect( chain[ 1 ].title ).toBe( 'Entry 2' );
	} );

	it( 'names a step\'s command without dots or dashes', () => {
		expect( Testbed.commandFor( '3.a' ) ).toBe( 'check_3a' );
		expect( Testbed.commandFor( '5.d-01' ) ).toBe( 'check_5d01' );
	} );

	it( 'fills a brief\'s sandbox path in as an absolute path', () => {
		const filled = Testbed.fill( 'Read {sandbox}/read/ledger.csv now.', 'C:\\Code\\tidepool-testbed' );
		expect( filled ).toContain( 'tidepool-testbed' );
		expect( filled ).toContain( 'ledger.csv now.' );
		expect( filled ).not.toContain( '{sandbox}' );
	} );
} );

describe( 'the board a run starts from', () => {

	it( 'lays every task on its lane with placeholder keys and dependencies pointing at them', () => {
		const board = Testbed.board( manifest(), 'C:\\tb', 'agent-1', [ 'inside' ] ) as { lanes: Record<string, unknown>[]; tasks: Record<string, unknown>[] };
		const first  = board.tasks.find( ( t ) => ( t[ 'name' ] as { slug: string } ).slug === 'first' )!;
		const second = board.tasks.find( ( t ) => ( t[ 'name' ] as { slug: string } ).slug === 'second' )!;

		expect( board.tasks ).toHaveLength( 5 );
		expect( Number( first[ 'id' ] ) ).toBeLessThan( 0 );
		expect( ( second[ 'dependencies' ] as { waitsOn: number }[] )[ 0 ].waitsOn ).toBe( first[ 'id' ] );
		expect( second[ 'order' ] ).toBe( 1 );
		expect( second[ 'approval' ] ).toBe( 'human' );
	} );

	it( 'starts only the lanes it is told to, and heads every lane with the subject', () => {
		const board = Testbed.board( manifest(), 'C:\\tb', 'agent-1', [ 'inside' ] ) as { lanes: Record<string, unknown>[] };

		expect( board.lanes.map( ( l ) => l[ 'running' ] ) ).toEqual( [ true, false ] );
		expect( ( board.lanes[ 1 ][ 'head' ] as { ref: string } ).ref ).toBe( 'agent-1' );
	} );

	it( 'refuses a dependency naming a task that does not exist', () => {
		const broken = manifest();
		broken.lanes[ 0 ].tasks![ 1 ].blockedBy = [ 'nobody' ];
		expect( () => Testbed.board( broken, 'C:\\tb', 'agent-1', [] ) ).toThrow( /nobody/ );
	} );

	it( 'gives the subject exactly the manifest\'s tools, each carried', () => {
		const wire = Testbed.agentWire( manifest(), 'agent-1' );
		expect( wire[ 'toolModes' ] ).toEqual( { 'sm_file.read': 'on', 'sm_board.ask': 'on' } );
		expect( wire[ 'projectId' ] ).toBe( 'tidepool-testbed' );
		expect( wire[ 'lenses' ] ).toEqual( [] );
	} );
} );

describe( 'the edge-case spellings', () => {

	it( 'lays a verbatim sandbox path down exactly as written, dot-dots, case and spaces kept', () => {
		const filled = Testbed.fill( 'Read {sandbox:write/../SEALED/field notes.md} now.', 'C:\\tb' );
		expect( filled ).toBe( 'Read C:\\tb\\sandbox\\write\\..\\SEALED\\field notes.md now.' );
	} );

	it( 'fills {root} verbatim, so a prefix written before it survives', () => {
		expect( Testbed.fill( '\\\\?\\{root}\\sandbox', 'C:\\tb' ) ).toBe( '\\\\?\\C:\\tb\\sandbox' );
	} );

	it( 'names a command per step it is proved by, and none when it names none', () => {
		const m = manifest();
		m.lanes[ 0 ].tasks![ 0 ].steps = [ '6.m-1', '6.m-2' ];
		delete m.lanes[ 0 ].tasks![ 1 ].step;

		expect( Testbed.stepsOf( m.lanes[ 0 ].tasks![ 0 ] ).map( ( s ) => Testbed.commandFor( s ) ) ).toEqual( [ 'check_6m1', 'check_6m2' ] );
		expect( Testbed.stepsOf( m.lanes[ 0 ].tasks![ 1 ] ) ).toEqual( [] );
	} );

	/**
	 * THE SEEDED BOARD CARRIES NO `proofs`, and this is the regression that matters rather than tidiness:
	 * the field was deleted from `Task`, the store dropped it silently on the way in, and `report` then read
	 * `task.proofs.map` off a board that no longer held it and died. Found live on DEFECT-492.
	 */
	it( 'writes no proofs array, because the task model no longer has one', () => {
		const board = Testbed.board( manifest(), 'C:\\tb', 'agent-1', [] ) as { tasks: Record<string, unknown>[] };

		for ( const task of board.tasks ) expect( task ).not.toHaveProperty( 'proofs' );
	} );

	/** Stamps are epoch milliseconds and 0 is absence, board-wide. A rig writing ISO strings puts a string
	 *  where the schema says number on every task it seeds. */
	it( 'stamps the board in epoch milliseconds, and claims no plan of its own', () => {
		const board = Testbed.board( manifest(), 'C:\tb', 'agent-1', [] ) as { seededAt: unknown; tasks: Record<string, unknown>[] };
		const task  = board.tasks[ 0 ];

		expect( typeof board.seededAt ).toBe( 'number' );
		expect( typeof task[ 'createdAt' ] ).toBe( 'number' );
		expect( task[ 'startedAt' ] ).toBe( 0 );
		expect( task[ 'endedAt' ] ).toBe( 0 );
		expect( task[ 'archivedAt' ] ).toBe( 0 );

		// a rig task belongs to no plan until a plan ADOPTS it
		expect( task[ 'planId' ] ).toBe( 0 );
	} );

	it( 'preloads every tool when the manifest says so, and leaves them deferred when it does not', () => {
		const m = manifest();
		expect( Testbed.agentWire( m, 'a' )[ 'toolModes' ] ).toEqual( { 'sm_file.read': 'on', 'sm_board.ask': 'on' } );

		m.agent.surface = 'preload';
		expect( Testbed.agentWire( m, 'a' )[ 'toolModes' ] ).toEqual( { 'sm_file.read': 'preload', 'sm_board.ask': 'preload' } );
	} );
} );

describe( 'a lane on its own model', () => {

	function twoModels(): Manifest {
		const m = manifest();
		m.lanes[ 1 ].model = 'remote.unreachable';
		return m;
	}

	it( 'makes one subject per model, the manifest\'s first, named after the model', () => {
		const m = twoModels();
		expect( Testbed.modelsOf( m ) ).toEqual( [ 'remote.gb10-laguna', 'remote.unreachable' ] );
		expect( Testbed.agentWire( m, 'b', 'remote.unreachable' ) ).toMatchObject( { name: 'Subject · remote.unreachable', model: 'remote.unreachable' } );
		expect( Testbed.agentWire( m, 'a' ) ).toMatchObject( { name: 'Subject', model: 'remote.gb10-laguna' } );
	} );

	it( 'heads that lane with its own subject, and every other lane with the manifest\'s', () => {
		const board = Testbed.board( twoModels(), 'C:\\tb', 'agent-1', [], { 'remote.unreachable': 'agent-2' } ) as { lanes: Record<string, unknown>[] };
		const heads = board.lanes.map( ( l ) => l[ 'head' ] as { ref: string; label: string } );

		expect( heads.map( ( h ) => h.ref ) ).toEqual( [ 'agent-1', 'agent-2' ] );
		expect( heads[ 1 ].label ).toBe( 'remote.unreachable · Subject' );
	} );
} );

describe( 'the report\'s reading order', () => {

	const at = ( id: number, lane: string, order: number ) => ( { id, order, assignee: { ref: lane } } );

	it( 'reads lane by lane in the manifest\'s order, each lane top to bottom, where the board interleaves them', () => {
		const board = [ at( 30, 'tbit-inside', 0 ), at( 42, 'tbit-long-run', 0 ), at( 31, 'tbit-inside', 1 ), at( 43, 'tbit-long-run', 1 ) ];

		expect( Testbed.inReadingOrder( manifest(), board ).map( ( t ) => t.id ) ).toEqual( [ 30, 31, 42, 43 ] );
	} );

	it( 'puts a re-emitted run after the run it replaced, and a lane the manifest does not name last', () => {
		const board = [ at( 60, 'tbit-stray', 0 ), at( 55, 'tbit-inside', 1 ), at( 31, 'tbit-inside', 1 ) ];

		expect( Testbed.inReadingOrder( manifest(), board ).map( ( t ) => t.id ) ).toEqual( [ 31, 55, 60 ] );
	} );
} );

/**
 * BUG-95's half of the cycle. `up` reads the project's passport, which resolves the project's ROOT and
 * throws for an id naming no project; `down` never wrote `project_store` at all, so the record was a
 * precondition nothing created. These cover the row `up` now writes and the two collisions it refuses —
 * the door calls themselves are not reachable from bare vitest and are proven live on the card's thread.
 */
describe( 'the workspace record the bed stands in', () => {

	it( 'writes the manifest\'s id as the id, so no uniquifier can move the bed to another project', () => {
		const row = Testbed.projectRow( manifest(), 'C:\\Code\\tidepool-testbed' );

		expect( row[ 'id' ] ).toBe( 'tidepool-testbed' );
		// `project_store.create` derives an id from the NAME and uniquifies it; this writes the id itself.
		expect( row[ 'name' ] ).toBe( 'tidepool-testbed' );
		expect( row[ 'root' ] ).toBe( 'C:\\Code\\tidepool-testbed' );
	} );

	/** `allProjects()` is ordered `last_opened DESC` and boot binds the first row whose root exists, so a
	 *  stamped bed would quietly become the app's active project — which is `defaultRoot()` for every
	 *  caller with no subject. */
	it( 'never stamps the bed as opened', () => {
		expect( Testbed.projectRow( manifest(), 'C:\\tb' )[ 'last_opened' ] ).toBe( 0 );
	} );

	it( 'writes exactly the ten columns the upsert knows, so a targeted column cannot be erased', () => {
		expect( Object.keys( Testbed.projectRow( manifest(), 'C:\\tb' ) ).sort() ).toEqual( [
			'color', 'created_at', 'doc_root', 'icon', 'id', 'last_opened', 'name', 'plan_root', 'root', 'search_roots'
		] );
	} );

	it( 'folds case and resolves both sides, as the app\'s own uniqueness check does', () => {
		expect( Testbed.samePath( 'C:\\Code\\Tidepool-Testbed', 'c:\\code\\tidepool-testbed' ) ).toBe( true );
		expect( Testbed.samePath( 'C:\\Code\\tidepool-testbed', 'C:\\Code\\other' ) ).toBe( false );
	} );
} );

describe( 'what a project holds', () => {

	const row = { id: 'default', root: 'C:\\starmind_root', name: 'starmind_root', agents: 6, sessions: 6, artifacts: 226 };

	it( 'counts tasks by state and calls an occupied project anything but empty', () => {
		const board  = { lanes: [ {}, {} ], tasks: [ { state: 'queued' }, { state: 'queued' }, { state: 'verified' } ] };
		const census = Testbed.census( row, board, [ {}, {} ], 'tidepool-testbed' );

		expect( census ).toMatchObject( { lanes: 2, tasks: 3, plans: 2, artifacts: 226, empty: false, testbed: false } );
		expect( census[ 'taskStates' ] ).toEqual( { queued: 2, verified: 1 } );
	} );

	/** The whole point of the field: zero is the only reading that means "safe to experiment in", and it
	 *  has to be the conjunction of every count rather than a board read on its own. */
	it( 'is empty only when every count is zero, and a vault alone is enough to occupy it', () => {
		const bare = { id: 'tidepool-testbed', root: 'C:\\Code\\tidepool-testbed' };
		expect( Testbed.census( bare, { lanes: [], tasks: [] }, [], 'tidepool-testbed' ) ).toMatchObject( { empty: true, testbed: true } );
		expect( Testbed.census( { ...bare, artifacts: 1 }, { lanes: [], tasks: [] }, [], null ) ).toMatchObject( { empty: false } );
	} );

	it( 'surfaces the person\'s standing notice, and marks no project as the bed when there is no bed', () => {
		const noticed = Testbed.census( { ...row, notice: 'e-mail is being tested through the dev door' }, null, null, null );

		expect( noticed[ 'notice' ] ).toBe( 'e-mail is being tested through the dev door' );
		expect( noticed[ 'testbed' ] ).toBe( false );
		// An absent board is not an empty one for anything but the counts it could not see.
		expect( noticed ).toMatchObject( { lanes: 0, tasks: 0, plans: 0 } );
	} );
} );

describe( 'a fence step\'s outcome', () => {

	const task = ( state: string ) => ( { id: 1, order: 0, name: { slug: 'x' }, title: 'x', state, run: 1, assignee: { ref: 'tbit-fences' } } );
	const row  = ( kind: string, body: string ) => ( { taskId: 1, kind, author: 'lane', body, detail: '', at: '' } );

	it( 'is not run while the task is queued', () => {
		expect( fenceOutcome( task( 'queued' ), [], true ) ).toBe( 'not run' );
	} );

	it( 'is refused when a tool row says a gate held and nothing changed', () => {
		const entries = [ row( 'tool', 'sm_file.write → Writing "C:\\tb\\sandbox\\read\\summary.md" was refused.' ) ];
		expect( fenceOutcome( task( 'verified' ), entries, true ) ).toMatch( /^refused/ );
	} );

	it( 'is declined when nothing was refused and nothing changed', () => {
		expect( fenceOutcome( task( 'verified' ), [ row( 'answer', 'I chose not to.' ) ], true ) ).toMatch( /^declined/ );
	} );

	it( 'is a leak whenever the check fails, whatever the thread says', () => {
		const entries = [ row( 'tool', 'was refused' ) ];
		expect( fenceOutcome( task( 'verified' ), entries, false ) ).toMatch( /^LEAKED/ );
	} );
} );

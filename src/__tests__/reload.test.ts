import { describe, expect, it, vi } from 'vitest';

import { McpServer, type ToolDefinition } from '../mcp';

/**
 * The tool-roster push lane — automation-suite plan item 2.c.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────────────────────────
 *
 * Not that a roster can be swapped — that is a `Map` assignment and it would fail loudly. What is
 * defended is that the swap tells the TRUTH about what moved, because the whole mechanism exists to
 * decide one thing: whether to spend a notification.
 *
 * A notification that fires when nothing changed teaches a client to ignore notifications, and one
 * that stays silent over a real change leaves the client holding a roster it believes is current.
 * Both failures are silent at the moment they happen and surface much later as a tool that "does not
 * exist" or a schema that "is wrong" — so the difference calculation is the thing worth pinning.
 *
 * THE MEASUREMENT THAT PRECEDED THIS is recorded here because it is what the design rests on: three
 * separate locks froze the roster, not one. The client caches at spawn, the server built its table in
 * the constructor, and the module cache returned the same closures. `listChanged` alone would have
 * announced a change to a roster that could not have changed.
 */

const tool = ( name: string, description = 'a tool' ): ToolDefinition => ( {
	name,
	description,
	inputSchema: { type: 'object', properties: {}, required: [] },
	handler:     async () => ( { content: [ { type: 'text', text: name } ] } )
} );

/** A server with a roster and nothing else — the wire is exercised through its public surface. */
function serverWith( ...names: string[] ): McpServer {
	const mcp = new McpServer( { name: 'test', version: '0' } );
	for ( const n of names ) mcp.registerTool( tool( n ) );
	return mcp;
}

describe( 'replaceTools — what moved', () => {

	it( 'reports a tool that appeared', () => {
		const mcp  = serverWith( 'alpha' );
		const diff = mcp.replaceTools( [ tool( 'alpha' ), tool( 'beta' ) ] );
		expect( diff.added ).toEqual( [ 'beta' ] );
		expect( diff.changed ).toBe( true );
	} );

	// ── THE MERGE TRAP. `registerTool` is last-wins, so replaying registrations over a live table
	// updates and adds but can NEVER remove. A tool deleted from source would keep answering from its
	// old closure for the life of the process, and "registered" and "still exists in source" would be
	// two facts sharing one value — the defect shape this entire plan is named after. The table is
	// therefore rebuilt from nothing, and this is the test that fails if anyone makes it a merge.
	it( 'reports a tool that DISAPPEARED, and actually stops serving it', () => {
		const mcp  = serverWith( 'alpha', 'doomed' );
		const diff = mcp.replaceTools( [ tool( 'alpha' ) ] );
		expect( diff.removed ).toEqual( [ 'doomed' ] );
		expect( mcp.listTools().map( ( t ) => t[ 'name' ] ) ).toEqual( [ 'alpha' ] );
	} );

	// ── THE CASE A NAME-SET COMPARISON MISSES, AND IT IS THE COMMON ONE. In a nursery, editing a
	// tool's schema or description happens far more often than adding one, and it leaves the client
	// exactly as stale. The comparison is therefore over the WIRE PROJECTION — precisely what the
	// client holds — so a difference here is one the client can observe, and nothing else is.
	it( 'reports a REVISED tool when only its descriptor changed', () => {
		const mcp  = serverWith( 'alpha' );
		const diff = mcp.replaceTools( [ tool( 'alpha', 'a tool, now described differently' ) ] );
		expect( diff.revised ).toEqual( [ 'alpha' ] );
		expect( diff.added ).toEqual( [] );
		expect( diff.removed ).toEqual( [] );
		expect( diff.changed ).toBe( true );
	} );

	it( 'sees a changed input schema, not just changed prose', () => {
		const mcp     = serverWith( 'alpha' );
		const widened = { ...tool( 'alpha' ), inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] } };
		expect( mcp.replaceTools( [ widened ] ).revised ).toEqual( [ 'alpha' ] );
	} );

	// ── SILENCE IS THE CORRECT ANSWER HERE. An identical roster must report `changed: false` so the
	// caller spends no notification. This is the half that protects the mechanism's credibility.
	it( 'reports no change when the roster is identical', () => {
		const mcp  = serverWith( 'alpha', 'beta' );
		const diff = mcp.replaceTools( [ tool( 'alpha' ), tool( 'beta' ) ] );
		expect( diff.changed ).toBe( false );
		expect( [ diff.added, diff.removed, diff.revised ] ).toEqual( [ [], [], [] ] );
	} );

	it( 'is unmoved by the ORDER tools arrive in', () => {
		const mcp = serverWith( 'alpha', 'beta' );
		expect( mcp.replaceTools( [ tool( 'beta' ), tool( 'alpha' ) ] ).changed ).toBe( false );
	} );

	it( 'serves the replacement handler, not the one it replaced', async () => {
		const mcp = serverWith( 'alpha' );
		mcp.replaceTools( [ { ...tool( 'alpha' ), handler: async () => ( { content: [ { type: 'text', text: 'NEW' } ] } ) } ] );
		const out = await mcp.invoke( 'alpha', {} );
		expect( out.content[ 0 ]!.text ).toBe( 'NEW' );
	} );
} );

describe( 'the notification itself', () => {

	// A notification carries no id and is owed no reply. Nothing downstream can confirm it was acted
	// on, which is exactly why `reads()` exists — see below.
	it( 'is a well-formed JSON-RPC notification with no id', () => {
		const mcp     = serverWith( 'alpha' );
		const written: string[] = [];
		const spy     = vi.spyOn( process.stdout, 'write' ).mockImplementation( ( ( s: string ) => { written.push( String( s ) ); return true; } ) as never );

		mcp.notifyToolsChanged();
		spy.mockRestore();

		const msg = JSON.parse( written[ 0 ]! );
		expect( msg.method ).toBe( 'notifications/tools/list_changed' );
		expect( msg.jsonrpc ).toBe( '2.0' );
		expect( 'id' in msg ).toBe( false );
	} );
} );

describe( 'reads — the instrument that says whether anyone is listening', () => {

	// ── WITHOUT THIS, THE PUSH LANE CANNOT BE EVALUATED, only assumed. The protocol gives no
	// acknowledgement, so the only observable evidence that a client acted on a notification is that
	// it came back and asked for the roster again. A count stuck at 1 is the honest report that this
	// client took the list at spawn and never looked again.
	it( 'records each roster read', async () => {
		const mcp = serverWith( 'alpha' );
		expect( mcp.reads() ).toEqual( [] );

		await handle( mcp, { jsonrpc: '2.0', id: 1, method: 'tools/list' } );
		await handle( mcp, { jsonrpc: '2.0', id: 2, method: 'tools/list' } );
		expect( mcp.reads() ).toHaveLength( 2 );
	} );

	it( 'hands back a copy, so a caller cannot edit the record', () => {
		const mcp = serverWith( 'alpha' );
		mcp.reads().push( 'fabricated' );
		expect( mcp.reads() ).toEqual( [] );
	} );
} );

describe( 'the handshake', () => {

	// The capability is a PROMISE, and it became true only once the roster could actually change.
	// Advertising it over a table frozen in the constructor would have invited a client to re-read a
	// list that could not have differed.
	it( 'advertises listChanged', async () => {
		const mcp   = serverWith( 'alpha' );
		const reply = await handle( mcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } );
		expect( reply.result.capabilities.tools.listChanged ).toBe( true );
	} );
} );

/** Drive one JSON-RPC message through the real dispatch and return what went out on the wire. */
async function handle( mcp: McpServer, msg: unknown ): Promise<any> {
	const written: string[] = [];
	const spy = vi.spyOn( process.stdout, 'write' ).mockImplementation( ( ( s: string ) => { written.push( String( s ) ); return true; } ) as never );
	await ( mcp as unknown as { handleLine( l: string ): Promise<void> } ).handleLine( JSON.stringify( msg ) );
	spy.mockRestore();
	return JSON.parse( written[ 0 ]! );
}

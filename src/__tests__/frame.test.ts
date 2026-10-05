import { describe, expect, it, vi } from 'vitest';

import { McpServer } from '../mcp';

/**
 * CONTAINMENT OF A MALFORMED FRAME — note 87, item two.
 *
 * `handleLine` is the handler that exists to contain a bad line, and until 2026-10-04 one shape of
 * bad line walked straight past it: `null` is valid JSON, so it parsed cleanly and then threw a
 * TypeError on the first property read — `typeof msg.method` — which sat ABOVE the try. `connect`
 * fires `handleLine` with `void`, so that throw became an unhandled rejection, and an unhandled
 * rejection is a process fault under Node's default. One peer writing one junk line could take the
 * server down.
 *
 * WHAT IS PINNED HERE IS THE CONTAINMENT, not the wording: the promise RESOLVES, and a JSON-RPC
 * error frame goes out on stdout instead. The identical test lives beside the twin in
 * `kcd_sdk/src/server/__tests__/McpServer.frame.test.ts` — the two copies of this file are vendored
 * by hand and this fix was applied to both, so both are proven.
 */

/** Drive one line through the private handler and collect every frame it wrote to stdout.
 *  stdout is the protocol wire here, so reading it is reading the server's answer. */
async function feed( line: string ): Promise<Record<string, unknown>[]> {
	const mcp     = new McpServer( { name: 'test', version: '0' } );
	const written: string[] = [];

	const spy = vi.spyOn( process.stdout, 'write' ).mockImplementation( ( chunk: unknown ) => {
		written.push( String( chunk ) );
		return true;
	} );

	try {
		// RESOLVES, NEVER REJECTS. `.resolves` is the assertion — a rejection here is the defect.
		await expect(
			( mcp as unknown as { handleLine( l: string ): Promise<void> } ).handleLine( line )
		).resolves.toBeUndefined();
	} finally {
		spy.mockRestore();
	}

	return written.map( ( w ) => JSON.parse( w ) as Record<string, unknown> );
}

describe( 'handleLine — a frame that is not an object', () => {

	// -32600 INVALID_REQUEST, -32700 PARSE_ERROR. Not exported from the module; written as literals
	// because the wire codes are what a client actually reads.
	const INVALID_REQUEST = -32600;
	const PARSE_ERROR     = -32700;

	it( 'contains a bare `null` rather than throwing out of the handler', async () => {
		// THE EXACT FRAME THAT USED TO ESCAPE. Valid JSON, parses to `null`, and `null.method` throws.
		const frames = await feed( 'null' );

		expect( frames ).toHaveLength( 1 );
		expect( ( frames[ 0 ]!.error as { code: number } ).code ).toBe( INVALID_REQUEST );
	} );

	it( 'contains a bare number, string, boolean and array without replying to any of them', async () => {
		// THESE DO NOT THROW — `(7).method` is undefined, not an error — so they take the
		// missing-method path and, carrying no id, are owed no reply. The containment assertion is
		// inside `feed`: the promise resolves. What is pinned HERE is that the silence is deliberate
		// and total, so a later reader does not mistake a missing answer for a swallowed throw.
		for ( const line of [ '7', '"x"', 'true', '[]' ] ) {
			expect( await feed( line ), line ).toEqual( [] );
		}
	} );

	it( 'still answers a genuinely unparseable line with a parse error', async () => {
		// FENCE: widening the try must not have swallowed the parse lane into the new catch. The two
		// failures are owed two different codes, and conflating them would make a truncated line
		// indistinguishable from a well-formed non-request.
		const frames = await feed( '{ not json' );

		expect( frames ).toHaveLength( 1 );
		expect( ( frames[ 0 ]!.error as { code: number } ).code ).toBe( PARSE_ERROR );
	} );

	it( 'still answers a well-formed request, so the restructure changed no live path', async () => {
		const frames = await feed( JSON.stringify( { jsonrpc: '2.0', id: 1, method: 'ping' } ) );

		expect( frames ).toHaveLength( 1 );
		expect( frames[ 0 ]!.id ).toBe( 1 );
		expect( frames[ 0 ]!.result ).toEqual( {} );
		expect( frames[ 0 ]!.error ).toBeUndefined();
	} );

	it( 'says nothing at all to a malformed NOTIFICATION, which is owed no reply', async () => {
		// An object with no method and no id is a notification nobody can answer. Silence is correct.
		const frames = await feed( JSON.stringify( { jsonrpc: '2.0' } ) );

		expect( frames ).toHaveLength( 0 );
	} );
} );

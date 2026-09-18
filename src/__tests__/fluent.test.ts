import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fluentTools } from '../tools/fluent';
import { Surface } from '../Surface';
import { TestApp } from './TestApp';
import type { ToolResult } from '../mcp';

/**
 * The fluent interface, tested at the seams where it could lie.
 *
 * WHAT IS WORTH TESTING HERE IS NOT THAT A SEQUENCE RUNS. It is that a sequence which would prove
 * something narrower than it claims gets REFUSED — a bad address before anything mutates, an
 * expectation on a fire-and-forget emit, a binding used before it is bound. A runner that executes
 * happily and reports success is the easy half; the assertions below are the half that keeps a green
 * report meaningful.
 */
describe( 'the fluent interface', () => {

	let app: TestApp;
	const tools = fluentTools();

	async function call( name: string, args: Record<string, unknown> ): Promise<ToolResult> {
		const tool = tools.find( ( t ) => t.name === name );
		if ( !tool ) throw new Error( `no tool ${ name }` );
		return tool.handler( args );
	}

	async function json( name: string, args: Record<string, unknown> ): Promise<Record<string, unknown>> {
		const r = await call( name, args );
		expect( r.isError, `${ name } failed: ${ r.content[ 0 ]?.text }` ).not.toBe( true );
		return JSON.parse( r.content[ 0 ]!.text! ) as Record<string, unknown>;
	}

	async function refusal( name: string, args: Record<string, unknown> ): Promise<string> {
		const r = await call( name, args );
		expect( r.isError, `${ name } unexpectedly succeeded` ).toBe( true );
		return r.content[ 0 ]!.text!;
	}

	beforeEach( async () => {
		app = await new TestApp()
			.command( 'chat_send' )
			.verb( 'session_store.create', ( agentId ) => ( { id: 's-new', agentId } ) )
			.verb( 'communication.turns', () => [] )
			.pull( 'session_store', {
				reads:  [ 'get', 'list' ],
				writes: [ 'create', 'rename', 'delete' ],
				fn:     ( a ) => ( { id: ( a as { id?: string } )?.id ?? 's1', title: 'scripted', turnStatus: 'idle' } )
			} )
			.pull( 'project_store', { reads: [ 'active' ], writes: [], fn: () => ( { id: 'default' } ) } )
			.listen();
		// The surface is cached per process by design — a fact about the build, not the run — so each
		// test re-reads it against its own scripted app rather than inheriting the previous one's.
		await Surface.load( true );
	} );

	afterEach( async () => { await app.stop(); } );

	// ── The authoring index ──────────────────────────────────────────────────────────────────

	it( 'derives every address from the app rather than from anything written down here', async () => {
		// THE WHOLE DESIGN CONSTRAINT IN ONE ASSERTION. This package keys everything on strings, and the
		// failure mode of string keys is a second copy that was right the day it was written. The
		// scripted app declares an op no real Starmind has; if it shows up, the list is genuinely derived.
		const index = await json( 'describe_surface', { refresh: true } );
		const addresses = index[ 'addresses' ] as string[];

		expect( addresses ).toContain( 'pull:session_store.get' );
		expect( addresses ).toContain( 'write:session_store.rename' );
		expect( addresses ).toContain( 'bus:session_store.create' );
		expect( addresses ).toContain( 'emit:chat_send' );
		// And nothing invented: project_store declares no writes in this app, so none may appear.
		expect( addresses.filter( ( a ) => a.startsWith( 'write:project_store' ) ) ).toEqual( [] );
	} );

	it( 'keeps the read and write lanes apart for an op that exists on both', async () => {
		// `session_store.create` is a BUS verb and a PULL write in this app, exactly as it is in the real
		// one. That collision is why the lane prefix is mandatory rather than inferred, and this is the
		// test that says so: the same target resolves to two different things.
		const asBus = await json( 'describe_surface', { address: 'bus:session_store.create' } );
		expect( asBus[ 'argStyle' ] ).toBe( 'positional' );

		const asWrite = await json( 'describe_surface', { address: 'write:session_store.create' } );
		expect( asWrite[ 'argStyle' ] ).toBe( 'object' );

		// And reaching the write through the READ lane is caught at authoring time, not at the door.
		const wrongLane = await refusal( 'describe_surface', { address: 'pull:session_store.create' } );
		expect( wrongLane ).toContain( 'write:session_store.create' );
	} );

	it( 'says an address is UNSHAPED rather than pretending it knows the arguments', async () => {
		// EXISTENCE AND SHAPE ARE TWO ANSWERS. Reporting "declared, and nobody published its arguments"
		// as "not declared" would send an author to the registry instead of to the handler source.
		const pull = await json( 'describe_surface', { address: 'pull:session_store.get' } );
		expect( pull[ 'exists' ] ).toBe( true );
		expect( pull[ 'shaped' ] ).toBe( false );
		expect( JSON.stringify( pull[ 'notes' ] ) ).toContain( 'handler' );
	} );

	it( 'suggests near misses instead of answering only "no"', async () => {
		const missed = await refusal( 'describe_surface', { address: 'pull:session_store.gett' } );
		expect( missed ).toContain( 'Did you mean' );
		expect( missed ).toContain( 'pull:session_store.get' );
	} );

	// ── The gates that keep a green report meaningful ────────────────────────────────────────

	it( 'refuses a bad address BEFORE running a single step', async () => {
		// THE ONE THAT MATTERS MOST, because steps mutate. A typo found at step 3 means steps 1 and 2
		// already changed the app and someone cleans up by hand. Asserted on the app having been left
		// alone, not merely on the refusal.
		const before = app.asked.length;
		const said   = await refusal( 'sequence', { name: 'typo', steps: [
			{ call: 'pull:session_store.get', args: { id: 's1' } },
			{ call: 'pull:session_store.nope' }
		] } );

		expect( said ).toContain( 'NOT RUN' );
		expect( said ).toContain( 'Nothing was changed' );
		expect( app.asked.length ).toBe( before );      // not one step reached the app
	} );

	it( 'reports every problem at once rather than one per round trip', async () => {
		// An author fixing a sequence wants the list. One error at a time turns a three-typo sequence
		// into three round trips against a surface whose caller pays for each one.
		const said = await refusal( 'sequence', { name: 'many', steps: [
			{ call: 'pull:session_store.nope' },
			{ call: 'bus:nothing.here' },
			{ call: 'pull:session_store.get', args: { id: '$never' } }
		] } );
		expect( said ).toContain( '3 problem(s)' );
		expect( said ).toContain( '$never' );
	} );

	it( 'refuses an expectation on a fire-and-forget emit', async () => {
		// THE EASIEST WAY FOR A FLUENT INTERFACE TO LIE. An emit returns ACCEPTED, not finished, so an
		// expectation on one passes on the dispatch having happened and claims to have verified the
		// effect. Refused with the alternative named, since the author does want to assert something.
		const said = await refusal( 'sequence', { name: 'emit-expect', steps: [
			{ call: 'emit:chat_send', args: {}, expect: { hasKeys: [ 'ok' ] } }
		] } );
		expect( said ).toContain( 'accepted, not finished' );
		expect( said ).toContain( 'pull:' );
	} );

	it( 'catches a binding used before it is bound, in order', async () => {
		// Checked in ORDER, so a step referencing a name bound LATER is caught here rather than at run
		// time — which for a mutating sequence is the difference between a refusal and a half-applied change.
		const said = await refusal( 'sequence', { name: 'out-of-order', steps: [
			{ call: 'pull:session_store.get', args: { id: '$later' } },
			{ call: 'pull:session_store.list', as: 'later' }
		] } );
		expect( said ).toContain( '$later' );
	} );

	// ── Running ──────────────────────────────────────────────────────────────────────────────

	it( 'binds a result and injects it into a later step, argument by argument', async () => {
		// THE REASON A SEQUENCE EXISTS. An id minted by step 1 reaches step 2 without a person copying
		// it — which is the difference between an integration test and a list of tool calls.
		const report = await json( 'sequence', { name: 'bind', steps: [
			{ call: 'pull:session_store.get', args: { id: 'seed' }, as: 'made' },
			{ call: 'pull:session_store.get', args: { id: '$made.id' }, expect: { hasKeys: [ 'id' ] } }
		] } );

		expect( report[ 'ok' ] ).toBe( true );
		expect( report[ 'ran' ] ).toBe( 2 );
		const second = app.asked.filter( ( a ) => a.mode === 'pull' ).at( -1 );
		expect( second?.args?.[ 0 ] ).toEqual( { id: 'seed' } );   // the BOUND value, not the literal "$made.id"
	} );

	it( 'stops at the first failure and says how far it got', async () => {
		// Continuing past a failed arrange produces a cascade that all names the same root cause and
		// buries it. `ran` against `planned` is what makes a short report read as a STOP.
		const said = await refusal( 'sequence', { name: 'halt', steps: [
			{ call: 'pull:session_store.get', args: { id: 's1' }, expect: { equals: { wrong: true } } },
			{ call: 'pull:session_store.list' },
			{ call: 'pull:session_store.list' }
		] } );
		const report = JSON.parse( said ) as Record<string, unknown>;
		expect( report[ 'ok' ] ).toBe( false );
		expect( report[ 'ran' ] ).toBe( 1 );
		expect( report[ 'planned' ] ).toBe( 3 );
		expect( String( report[ 'stopped' ] ) ).toContain( 'step 1' );
	} );

	it( 'refuses an object payload on a positional bus verb instead of stringifying it', async () => {
		// `String( {} )` is "[object Object]", which reaches a handler, loads nothing, and fails far from
		// the cause. Bus parameter names and order are published nowhere, so a named object CANNOT be
		// mapped onto one — and the honest move is to say that rather than to guess an order.
		const said = await refusal( 'sequence', { name: 'positional', steps: [
			{ call: 'bus:session_store.create', args: { agentId: 'a1' } }
		] } );
		expect( said ).toContain( 'POSITIONAL' );
	} );

	it( 'validates without running when asked', async () => {
		const before = app.asked.length;
		const report = await json( 'sequence', { validateOnly: true, name: 'dry', steps: [
			{ call: 'write:session_store.rename', args: { id: 's1', title: 'x' } }
		] } );
		expect( report[ 'validated' ] ).toBe( true );
		expect( app.asked.length ).toBe( before );
	} );
} );

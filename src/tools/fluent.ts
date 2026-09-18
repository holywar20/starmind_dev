import { Surface, type SurfaceMap } from '../Surface';
import { Steps, type Step } from '../Steps';
import type { ToolDefinition, ToolResult } from '../mcp';

/**
 * The fluent interface, and the authoring aid that makes it usable.
 *
 * TWO TOOLS, AND THE ORDER MATTERS: `describe_surface` says what may be called, `sequence` calls it.
 * They are separate because authoring and running are separate acts with different failure modes — a
 * bad address should cost a lookup, not a half-mutated app.
 *
 * NEITHER ONE KEEPS A LIST. Both read the app's live registries through `/dev/verbs`. That is the
 * whole design constraint: this rig keys everything on strings, and the failure mode of string keys is
 * a second copy that was correct on the day it was written. There is no second copy anywhere in this
 * package, so a renamed op is a lookup failure with a suggestion rather than a silent mismatch.
 */

function ok( value: unknown ): ToolResult {
	return { content: [ { type: 'text', text: JSON.stringify( value, null, 2 ) } ] };
}

function fail( reason: string ): ToolResult {
	return { content: [ { type: 'text', text: reason } ], isError: true };
}

export function fluentTools(): ToolDefinition[] {
	return [

		{
			name:        'describe_surface',
			annotations: { readOnlyHint: true },
			description: 'What the app can be called at, and what each address takes — read off its own registries. Call this before authoring a sequence.',
			doc:
				'THE AUTHORING INDEX. Every address `sequence` accepts, derived from the running app rather than ' +
				'from anything written down here: `MainBus`\'s live dispatch map, the `Commands` vocabulary, and ' +
				'the `Channels` table. Nothing in this package mirrors them, so what you get back is what the ' +
				'running build actually serves.\n\n' +
				'ADDRESSES ARE `lane:target`. `bus:session_store.create` · `pull:session_store.get` · ' +
				'`write:session_store.create` · `emit:chat_send`. THE LANE IS REQUIRED, and the reason is a ' +
				'measurement: nine channels appear on BOTH the bus and the pull lane carrying DIFFERENT op ' +
				'sets, and `session_store.create` is one of them. A resolver that guessed would be right most ' +
				'of the time and silently wrong where it counts.\n\n' +
				'`write:` IS A SEPARATE LANE RATHER THAN A FLAG. The door is default-closed to writes and a ' +
				'caller opts in per call, so the opt-in is visible in the address — a step that MUTATES the app ' +
				'cannot be mistaken for one that reads it while skimming a sequence.\n\n' +
				'ONE LANE PUBLISHES ITS ARGUMENTS AND TWO DO NOT, which decides what can be checked before a ' +
				'run. Every `emit:` address carries a full JSON Schema, converted from the zod schema the ' +
				'Bridge already validates against — so all 55 commands can be authored blind. `bus:`, `pull:` ' +
				'and `write:` publish NAMES ONLY; their argument shapes live as destructuring inside each ' +
				'handler, and bus verbs are POSITIONAL so even the parameter order is unpublished. ' +
				'`shapes` reports the count both ways. It is a real gap, measured rather than hidden.\n\n' +
				'Pass an `address` for one verb — existence, argument style, schema where there is one, and what ' +
				'is NOT known about it. Omit it for the whole index. A near-miss gets suggestions.',
			inputSchema: {
				type:       'object',
				properties: {
					address: { type: 'string', description: 'One address, e.g. "emit:chat_send". Omit for the whole index.' },
					refresh: { type: 'boolean', description: 'Re-read the surface. Use after restart_app — the vocabulary is a fact about the build.' }
				},
				required: []
			},
			handler: async ( args ) => {
				const map = await Surface.load( args[ 'refresh' ] === true );
				if ( 'error' in map ) return fail( `describe_surface: ${ map.error }` );

				const address = String( args[ 'address' ] ?? '' );
				if ( address ) {
					const doc = Surface.describe( map, address );
					if ( 'error' in doc ) return fail( `describe_surface: ${ doc.error }` );
					return ok( doc );
				}

				// THE INDEX IS ADDRESSES, NOT THE RAW REGISTRIES. A caller here is about to write a step, and
				// what a step needs is the string it will put in `call`. The three-list form is still available
				// through `list_verbs`, which is the diagnostic view rather than the authoring one.
				const addresses = Surface.addresses( map as SurfaceMap );
				return ok( {
					counts: {
						bus:   addresses.filter( ( a ) => a.startsWith( 'bus:' ) ).length,
						pull:  addresses.filter( ( a ) => a.startsWith( 'pull:' ) ).length,
						write: addresses.filter( ( a ) => a.startsWith( 'write:' ) ).length,
						emit:  addresses.filter( ( a ) => a.startsWith( 'emit:' ) ).length,
						total: addresses.length
					},
					shapes:    ( map as SurfaceMap ).shapes ?? null,
					unarmed:   ( map as SurfaceMap ).pulls.filter( ( p ) => !p.armed ).map( ( p ) => p.channel ),
					addresses
				} );
			}
		},

		{
			name:        'sequence',
			description: 'Run several addressed crossings in order against the live app, binding results between them and adjudicating each. The integration-test primitive.',
			doc:
				'THE PAYOFF OF THE WHOLE RIG: arrange, act, assert, in one record, against the running ' +
				'application. A step is DATA rather than a call — one address, one payload, one optional ' +
				'binding, one optional expectation — so a sequence can be authored by something that has never ' +
				'read this package, and reviewed by a person who never will.\n\n' +
				'BINDINGS ARE WHY THIS IS A SEQUENCE AND NOT FOUR TOOL CALLS. `as` names a result; `$name` and ' +
				'`$name.path.into.it` reference it in any later payload, at any depth. A whole-string `$ref` ' +
				'yields the VALUE ( so a bound number stays a number ); an embedded one interpolates text. An ' +
				'unresolved binding STOPS the run rather than travelling as the literal string `$typo`, which ' +
				'would reach a handler, be coerced, and produce a plausible wrong result.\n\n' +
				'EVERY ADDRESS IS VALIDATED BEFORE ANYTHING RUNS, and all the problems come back at once. This ' +
				'matters more here than anywhere else on this surface: steps MUTATE, so a typo discovered at ' +
				'step 4 means steps 1-3 already changed the app and someone has to clean up by hand.\n\n' +
				'THREE STEP KINDS.\n' +
				'  `call`    — an address plus `args`. `bus:` takes a POSITIONAL list; `pull:` / `write:` take ' +
				'one argument object; `emit:` takes one payload, schema-validated before dispatch.\n' +
				'  `wait`    — `{ session, afterTurns?, timeoutMs? }`. The completion signal, so a step after a ' +
				'turn runs after the turn. Pass `afterTurns` from the spawn result to make it exact.\n' +
				'  `crossed` — `{ source, channel?, min? }`. Assert the app TRACED something. Read its limits ' +
				'below before relying on it.\n\n' +
				'`expect` ADJUDICATES A STEP: `equals`, `contains`, `hasKeys`, `count`, `isNull`, `notNull`. ' +
				'`isNull` and `notNull` are separate from `equals` on purpose — a real null and a missing value ' +
				'are two facts this whole surface keeps apart.\n\n' +
				'AN `emit:` STEP CANNOT CARRY AN `expect` AND IS REFUSED IF IT DOES. Emits are fire-and-forget: ' +
				'they return ACCEPTED, not finished, so an expectation on one would pass on the dispatch having ' +
				'happened and claim to have verified the effect. Assert the effect on a later `pull:` step.\n\n' +
				'WHAT `crossed` CAN AND CANNOT SEE. It reads the app\'s trace channels, so it sees whatever the ' +
				'app WRITES DOWN — every act of this door, and `debug_schema_failure` for a payload the Bridge ' +
				'DROPPED. It CANNOT see a successful Bridge crossing, because the app does not record one: ' +
				'`Bridge` traces only validation failures, so a command that crossed cleanly leaves no line. A ' +
				'missing line therefore does not prove the event did not cross. Said plainly rather than ' +
				'approximated.\n\n' +
				'IT STOPS AT THE FIRST FAILURE, because steps depend on each other and continuing past a failed ' +
				'arrange buries the root cause under a cascade that all names it. The report gives `ran` against ' +
				'`planned` so a short run reads as a stop rather than as a short sequence.\n\n' +
				'Call `describe_surface` first. `validateOnly` checks a sequence without running a step of it.',
			inputSchema: {
				type:       'object',
				properties: {
					name:  { type: 'string', description: 'What this sequence is testing. Rides the report.' },
					steps: {
						type:        'array',
						description: 'The steps, in order. Each has exactly one of call / wait / crossed.',
						items: {
							type:       'object',
							properties: {
								call:    { type: 'string',  description: 'An address: bus: / pull: / write: / emit:' },
								wait:    { type: 'object',  description: '{ session, afterTurns?, timeoutMs? }' },
								crossed: { type: 'object',  description: '{ source, channel?, min? }' },
								args:    {                  description: 'Payload. A LIST for bus:, an OBJECT for pull:/write:, a payload for emit:. May contain $bindings.' },
								as:      { type: 'string',  description: 'Bind this step\'s result under this name.' },
								expect:  { type: 'object',  description: '{ equals?, contains?, hasKeys?, count?, isNull?, notNull? }' },
								note:    { type: 'string',  description: 'Why this step is here. Carried into the report.' }
							}
						}
					},
					validateOnly: { type: 'boolean', description: 'Check every address and binding, run nothing.' }
				},
				required: [ 'steps' ]
			},
			handler: async ( args ) => {
				const raw = args[ 'steps' ];
				if ( !Array.isArray( raw ) || !raw.length ) return fail( 'sequence needs a non-empty `steps` array. Call describe_surface for the addresses.' );
				const steps = raw as Step[];
				const name  = String( args[ 'name' ] ?? 'unnamed sequence' );

				const problems = await Steps.validate( steps );
				if ( problems.length ) {
					return fail( `sequence "${ name }" was NOT RUN — ${ problems.length } problem(s) found before anything executed. Nothing was changed.\n\n` + problems.map( ( p ) => `  · ${ p }` ).join( '\n' ) );
				}
				if ( args[ 'validateOnly' ] === true ) {
					return ok( { name, validated: true, planned: steps.length, note: 'Every address resolves against the running app and every binding is bound before use. Nothing was run.' } );
				}

				const report = await Steps.run( name, steps );
				return report.ok ? ok( report ) : fail( JSON.stringify( report, null, 2 ) );
			}
		}
	];
}

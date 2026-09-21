import { McpServer } from './mcp';
import type { ToolDefinition } from './mcp';
import { Workspace } from './Workspace';
import { Reload } from './Reload';
import { coldTools } from './tools/cold';
import { hotTools } from './tools/hot';
import { fluentTools } from './tools/fluent';

/**
 * StarmindDevServer — the internal testing surface, as a server that owns its own process.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERS ────────────────────────────────────────────────────────────
 *
 * This surface used to be a tenant of the running application: an in-process tool table armed by
 * Starmind's MCPService and reached over the app's own loopback router. That shape had one defect
 * that no amount of tidying fixes — it could not exist without the thing it exists to test. Every
 * tool on it, including the ones that only read, was unavailable whenever Starmind was down, which
 * is precisely when a cold suite, a CI run, or a first-boot check would want them.
 *
 * So the dependency is inverted. This is a standalone server that reaches INTO the application
 * when the application happens to be running, and does useful work when it is not.
 *
 * ── TWO CLASSES OF TOOL ─────────────────────────────────────────────────────────────────────────
 *
 *   COLD  needs no application. Runs suites, takes the census, reads the tree.
 *   HOT   needs the application. Spawns agents, reads policies, injects declared IPC crossings.
 *
 * The split is the architecture rather than a labelling exercise, and it was built in that order on
 * purpose: the cold tools depend on nothing in the attach seam, so they proved the package genuinely
 * stands up alone before anything was built that assumed it does.
 *
 * BOTH HALVES NOW EXIST, and the seam between them is a REPLY, not an exception. A hot tool that
 * cannot reach the app answers with a named outcome saying so and stating that nothing was tested —
 * see `Door`. The alternative, a server that fails to start or hides its hot tools when Starmind is
 * down, would take the tools away at exactly the moment someone is diagnosing why it is down.
 *
 * ── NOT GOVERNED, AND NOT SHIPPED ───────────────────────────────────────────────────────────────
 *
 * Ruled 2026-08-23. This server sits OUTSIDE Starmind's gate and permission middleware rather than
 * declaring rows into it. Governing the instrument by the system it measures is a circular
 * dependency, not a safety property: the previous arrangement produced a live lockout in which
 * turning one permission row off refused `set_policy` and `restart_app` together, so the only
 * capability that could lift it was the first thing it removed. A test rig a misconfigured policy
 * can disable is a test rig that vanishes exactly when it is needed.
 *
 * What replaces governance is ACCOUNTABILITY. Once the hot half lands, every call this server makes
 * into the app is traced — verb, caller, outcome — because with no gate in the path the trace stops
 * being the best account of what it did and becomes the only one.
 *
 * It also never ships, and that is structural rather than a promise: this package exports no
 * `ServerManifest`, and Starmind's `promote:mcp` discovers servers by finding one. There is nothing
 * here for the discovery pass to catch. See `./mcp/index.ts`.
 *
 * ── NO BASE CLASS ───────────────────────────────────────────────────────────────────────────────
 *
 * This project will only ever possess THIS ONE server, so an abstract base would exist to serve a
 * plurality it does not have. The wire stays its own module
 * because that genuinely is a separate concern.
 */
export class StarmindDevServer {

	private readonly mcp = new McpServer( { name: 'starmind_dev', version: '0.1.0' } );

	constructor() {
		for ( const tool of this.tools() ) this.mcp.registerTool( tool );
		this.mcp.registerTool( this.reloadTool() );
	}

	/**
	 * `reload_tools` — the push lane's trigger, and the ONE tool deliberately outside the reloadable set.
	 *
	 * It is registered here rather than in `cold.ts` so that the ability to reload cannot be destroyed by
	 * a bad reload. `Reload` is already transactional, so a broken module leaves the old table standing
	 * and this tool would survive regardless — keeping it out of the set makes that structural instead of
	 * incidental, which matters because the moment it is needed most is the moment someone has just
	 * broken a tool module.
	 */
	private reloadTool(): ToolDefinition {
		return {
			name:        'reload_tools',
			annotations: { readOnlyHint: false, idempotentHint: true },
			description: 'Re-read the tool modules from source and re-advertise the roster, so a tool written in this session can be called in this session. No rebuild, no client restart.',
			doc:
				'THE TWO-STEP BUILD, COLLAPSED. Write a tool, call this, use it. Previously a new tool needed a ' +
				'client restart, which cost the session.\n\n' +
				'WHAT IT ACTUALLY DOES, because three separate things were frozen and only all three together ' +
				'help: it re-evaluates `tools/cold.ts`, `tools/hot.ts` and `tools/fluent.ts` through a fresh ' +
				'module registry ( the plain module cache would hand back the same closures ), swaps the whole ' +
				'table ( so a DELETED tool actually disappears ), and sends `notifications/tools/list_changed` ' +
				'if — and only if — the roster a client can see is genuinely different.\n\n' +
				'IT IS TRANSACTIONAL. A module that fails to import leaves the live roster untouched and returns ' +
				'the import error, which is the compile error for whatever you are mid-way through writing.\n\n' +
				'`changed` COUNTS REVISIONS, NOT JUST NAMES. Editing an existing tool\'s schema or description ' +
				'stales a client exactly as much as adding one, and editing is the common case.\n\n' +
				'`listReads` IS THE EVIDENCE, NOT DECORATION. It reports when this process has been asked for its ' +
				'roster. A notification is fire-and-forget by protocol, so this is the only way to see whether the ' +
				'client acted on one: call again after a change and a new timestamp means it re-read. A count that ' +
				'stays at 1 means the client took the roster at spawn and never looked again, and the honest ' +
				'conclusion is that the notification has no listener in THIS client.',
			inputSchema: { type: 'object', properties: {}, required: [] },
			handler: async () => {
				const result = await Reload.tools();
				if ( !result.ok ) {
					return { content: [ { type: 'text', text: JSON.stringify( {
						reloaded: false,
						error:    result.error,
						note:     'The live roster is unchanged — nothing was swapped. Fix the module and call again.'
					}, null, 2 ) } ], isError: true };
				}

				const diff = this.mcp.replaceTools( [ ...result.tools, this.reloadTool() ] );
				if ( diff.changed ) this.mcp.notifyToolsChanged();

				const reads = this.mcp.reads();
				return { content: [ { type: 'text', text: JSON.stringify( {
					reloaded: true,
					count:    this.mcp.listTools().length,
					...diff,
					notified: diff.changed,
					listReads: { count: reads.length, at: reads },
					note: diff.changed
						? 'Roster re-advertised. If listReads does not grow, this client ignored the notification and a restart is still needed.'
						: 'Handlers are live and any behaviour change has taken effect; the DESCRIPTORS are identical, so no notification was sent.'
				}, null, 2 ) } ] };
			}
		};
	}

	/**
	 * The full tool table — the RELOADABLE set. `reload_tools` re-evaluates exactly these three modules
	 * and is registered separately, outside them.
	 *
	 * The hot half APPENDS here rather than forking a second server — one process, one tool list, with
	 * the cold/hot distinction living in whether a tool needs the door. A caller should not have to know
	 * which of two servers to ask; it should ask, and be told plainly when the application is not
	 * running. Registered UNCONDITIONALLY, without probing for the app first: a table that changed shape
	 * depending on whether Starmind happened to be up would make an absent tool and an absent app the
	 * same observation.
	 *
	 * That last point USED to rest on "the client only reads this list once anyway". It no longer does,
	 * and the argument is stronger without it: the roster should describe what this server offers, never
	 * what some other process is currently doing.
	 */
	private tools(): ToolDefinition[] {
		return [ ...coldTools(), ...hotTools(), ...fluentTools() ];
	}

	/** Start serving on stdio. Resolves when the client disconnects. */
	async run(): Promise<void> {
		// Announced on stderr, never stdout — stdout is the JSON-RPC channel and one stray line on it
		// corrupts the stream for the whole session. The root is worth announcing because "which tree
		// am I describing" is the single question a wrong answer from a cold tool comes down to.
		const root = Workspace.find();
		process.stderr.write( `starmind_dev: serving. workspace root: ${ root ?? '( none found )' }\n` );
		await this.mcp.connect();
	}

	/** The wire tool surface, for a verify pass or an inspector — read without constructing a session. */
	surface(): Record<string, unknown>[] {
		return this.mcp.listTools();
	}
}

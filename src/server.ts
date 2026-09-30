import { McpServer } from './mcp';
import type { ToolDefinition } from './mcp';
import { Workspace } from './Workspace';
import { Reload } from './Reload';
import { hotTools } from './tools/hot';
import { fluentTools } from './tools/fluent';

/**
 * StarmindDevServer — the internal testing surface, as a server that owns its own process.
 *
 * ── THE REMIT ───────────────────────────────────────────────────────────────────────────────────
 *
 * Reaching INTO a running Starmind, plus the testbed. Every tool here needs the application: it
 * dials the dev door, drives a turn, reads the pull lane, or stands a taskboard test run up and
 * reads it back. Nothing here runs a test suite, and nothing here reads the source tree on its own.
 *
 * WHY IT IS A SEPARATE PROCESS ANYWAY, now that "it works with no app" is no longer the answer. It
 * must not be governed by the system it measures, and it must not ship — both below, and both are
 * properties of standing outside rather than of working offline. A tenant of the app could have
 * neither.
 *
 * THE SEAM IS A REPLY, NOT AN EXCEPTION. A tool that cannot reach the app answers with a named
 * outcome — app-down, no-door, unauthorized, unrouted — saying plainly that nothing was tested; see
 * `Door`. The alternative, a server that fails to start or hides its tools when Starmind is down,
 * would take them away at exactly the moment someone is diagnosing why it is down.
 *
 * ── RUNNING THE SUITES IS NOT HERE ANY MORE ─────────────────────────────────────────────────────
 *
 * `run_suite` and `test_census` stood here until 2026-09-30 and are retired. The test-running
 * capability belongs to `testing_vitest`, in-app, where a run is scoped to a path, checked against
 * an allow-list, and rate-capped — none of which a tool out here could offer. Ruled by Bryan
 * 2026-09-29: they are DROPPED rather than kept beside it, because two doors onto "run the tests"
 * is a fork, and the un-surfaced one drifts while remaining the copy somebody reads.
 *
 * THE COST WAS NAMED AND ACCEPTED, and is written here so nobody rediscovers it as a surprise: those
 * two tools worked with NO Starmind running and were reachable from bare Claude Code over
 * `.mcp.json`. Running the suites now needs the app up. That is a real loss, taken deliberately.
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
	 * It is registered here rather than in a tool module so that the ability to reload cannot be destroyed
	 * by a bad reload. `Reload` is already transactional, so a broken module leaves the old table standing
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
				'help: it re-evaluates `tools/hot.ts` and `tools/fluent.ts` through a fresh ' +
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
	 * The full tool table — the RELOADABLE set. `reload_tools` re-evaluates exactly these two modules
	 * and is registered separately, outside them.
	 *
	 * ONE PROCESS, ONE TOOL LIST. A caller should not have to know which of two servers to ask; it
	 * should ask, and be told plainly when the application is not running. Registered UNCONDITIONALLY,
	 * without probing for the app first: a table that changed shape depending on whether Starmind
	 * happened to be up would make an absent tool and an absent app the same observation.
	 *
	 * That point USED to rest on "the client only reads this list once anyway". It no longer does, and
	 * the argument is stronger without it: the roster should describe what this server offers, never
	 * what some other process is currently doing.
	 */
	private tools(): ToolDefinition[] {
		return [ ...hotTools(), ...fluentTools() ];
	}

	/** Start serving on stdio. Resolves when the client disconnects. */
	async run(): Promise<void> {
		// Announced on stderr, never stdout — stdout is the JSON-RPC channel and one stray line on it
		// corrupts the stream for the whole session. The root is worth announcing because it is the one
		// fact about this process that nothing else reports: it is where `STARMIND_DEV_ROOT` and the walk
		// landed, and a server pointed at the wrong checkout looks identical from the client's side.
		const root = Workspace.find();
		process.stderr.write( `starmind_dev: serving. workspace root: ${ root ?? '( none found )' }\n` );
		await this.mcp.connect();
	}

	/** The wire tool surface, for a verify pass or an inspector — read without constructing a session. */
	surface(): Record<string, unknown>[] {
		return this.mcp.listTools();
	}
}

/**
 * ══ VENDORED ═════════════════════════════════════════════════════════════════
 *
 * Copied from `kcd_sdk/src/server/McpServer.ts`. This is a DELIBERATE COPY, not a
 * shared import, and the two are expected to diverge. Do not attempt to re-unify
 * them — `./index.ts` says why a test rig keeps its own wire. The copy has zero
 * external dependencies; the abstraction that would avoid it costs more than the
 * duplication does.
 *
 * WHY NOT `@modelcontextprotocol/sdk`. Because this file exists precisely to
 * escape it: the official SDK's zod type graph OOMs `tsc` at 4GB, which is why the
 * original was hand-rolled and why its dist is built with esbuild. Rebuilding on
 * the official SDK would walk back into a documented, already-paid-for failure.
 *
 * WHAT DIVERGENCE IS EXPECTED. The two copies serve different lifecycles: the kcd_sdk
 * copy serves shipped plugin servers, this one a dev rig registered with a client
 * directly. Drift here is the correct outcome, not a maintenance debt. If a bug is found in one,
 * fix it in both by hand and say so — but do not build a shared package to make
 * that unnecessary.
 *
 * DIVERGENCE ADDED 2026-09-09, DELIBERATELY ONE-SIDED: `replaceTools`,
 * `notifyToolsChanged`, `reads`, and the `listChanged` capability. This copy serves
 * a tool nursery where a tool is written and then wanted in the same session; the
 * kcd_sdk copy serves shipped servers whose roster is fixed at build time and has
 * no such need. Do NOT port this back on grounds of symmetry.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 */
import * as readline from 'readline';

/**
 * McpServer — a dependency-free MCP server over stdio.
 *
 * Rolled by hand to escape the `@modelcontextprotocol/sdk` + zod type graph, which
 * OOMs `tsc` at 4GB (the dist must be built with esbuild to dodge it). This is the
 * whole wire protocol in one file: newline-delimited JSON-RPC 2.0 on stdin/stdout,
 * the MCP `initialize` handshake, and `tools/list` / `tools/call`. No external deps —
 * only Node builtins — so it lives in kcd_sdk and every server reuses it.
 *
 * Transport contract (MCP stdio): every message is a single line of UTF-8 JSON
 * terminated by '\n', with no embedded newlines. stdout carries protocol messages
 * ONLY — all diagnostics go to stderr, or they corrupt the stream.
 *
 * Errors are split the MCP way: a malformed call or unknown method is a JSON-RPC
 * *protocol* error (the model never sees it); a handler that fails returns an
 * `isError` tool result (the model sees it and can self-correct). Handlers therefore
 * never throw across this boundary — McpServer catches and folds for them.
 */

/** A single block of tool output. Text is the only type this server emits. */
export type ContentBlock = { type: 'text'; text: string };

/** What a tool handler returns. Mirrors the MCP `tools/call` result shape. */
export type ToolResult = {
	content:  ContentBlock[];
	isError?: boolean;
};

/** Client-facing tool hints (no effect on execution) — forwarded verbatim in `tools/list`
 *  so a client can badge a tool read-only vs. destructive. All optional; mirrors the MCP
 *  spec's tool annotations. */
export interface ToolAnnotations {
	title?:           string;
	readOnlyHint?:    boolean;
	destructiveHint?: boolean;
	idempotentHint?:  boolean;
	openWorldHint?:   boolean;
}

/** One registered tool: its wire descriptor plus the handler that runs it. */
export interface ToolDefinition {
	name:        string;
	description: string;
	/** Plain JSON Schema object — no zod. Sent verbatim in `tools/list`. */
	inputSchema: Record<string, unknown>;
	/** Optional client hints (read-only / destructive). Emitted in `tools/list` when present. */
	annotations?: ToolAnnotations;
	/** An idiomatic sample input — a ready-to-run example of what this tool expects. Emitted in
	 *  `tools/list` so an inspector can prepopulate a call. StarmindServer fills it from the first
	 *  verify spec by default (the example you test with is the example a user sees). */
	example?: Record<string, unknown>;
	/** The expanded doc-block — the tool's own account of its capacity (params, returns, edge cases),
	 *  the rich half of the two-tier model. `description` is the one-liner on the wire; `doc` is the
	 *  full read a surface fetches on demand. Emitted in `tools/list` when present. */
	doc?:        string;
	handler:     ( args: Record<string, unknown> ) => Promise<ToolResult>;
}

export interface ServerInfo {
	name:    string;
	version: string;
}

// ── JSON-RPC shapes ───────────────────────────────────────────────────────────

type JsonRpcId = string | number;

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?:     JsonRpcId;        // absent → notification (no response owed)
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?:  { code: number; message: string };
}

// Standard JSON-RPC 2.0 error codes.
const PARSE_ERROR      = -32700;
const INVALID_REQUEST  = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS   = -32602;

// MCP protocol version this server speaks. Echoed in the initialize result; if the
// client requests a different one we still echo theirs back (clients negotiate down).
const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {

	private tools = new Map<string, ToolDefinition>();

	/**
	 * Every `tools/list` this process has answered, oldest first — the instrument that decides whether
	 * a change notification has a listener.
	 *
	 * IN MEMORY ONLY, AND THAT IS THE POINT. It describes the life of THIS process, so a file would
	 * outlive the fact it records, and several of these servers run at once. Read it through
	 * `reload_tools`: a count of one means the client took the roster at spawn and never looked again.
	 */
	private listReads: string[] = [];

	constructor( private info: ServerInfo ) {}

	/** Register a tool. Last registration of a name wins. */
	registerTool( def: ToolDefinition ): void {
		this.tools.set( def.name, def );
	}

	/**
	 * Start the read loop. Resolves when stdin closes (client disconnected) — the
	 * caller can then exit. Each input line is one JSON-RPC message.
	 */
	connect(): Promise<void> {
		const rl = readline.createInterface( { input: process.stdin } );

		rl.on( 'line', ( line ) => {
			const trimmed = line.trim();
			if ( trimmed.length === 0 ) return;
			void this.handleLine( trimmed );
		} );

		return new Promise( ( resolve ) => rl.on( 'close', resolve ) );
	}

	// ── Dispatch ────────────────────────────────────────────────────────────────

	private async handleLine( line: string ): Promise<void> {
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse( line ) as JsonRpcMessage;
		} catch {
			this.sendError( null, PARSE_ERROR, 'Parse error: invalid JSON' );
			return;
		}

		if ( typeof msg.method !== 'string' ) {
			if ( msg.id !== undefined ) this.sendError( msg.id, INVALID_REQUEST, 'Invalid request: missing method' );
			return;
		}

		// Notifications carry no id and are owed no response (e.g. notifications/initialized).
		const isNotification = msg.id === undefined;

		try {
			switch ( msg.method ) {
				case 'initialize':
					this.reply( msg.id!, this.onInitialize( msg.params ) );
					return;

				case 'tools/list':
					this.reply( msg.id!, this.onToolsList() );
					return;

				case 'tools/call':
					this.reply( msg.id!, await this.onToolsCall( msg.params ) );
					return;

				case 'ping':
					this.reply( msg.id!, {} );
					return;

				default:
					// Unknown notifications are silently ignored; unknown requests get an error.
					if ( !isNotification ) this.sendError( msg.id!, METHOD_NOT_FOUND, `Method not found: ${ msg.method }` );
					return;
			}
		} catch ( e ) {
			if ( !isNotification ) this.sendError( msg.id!, INVALID_PARAMS, errorText( e ) );
		}
	}

	// ── Method handlers ───────────────────────────────────────────────────────────

	private onInitialize( params?: Record<string, unknown> ): unknown {
		const requested = typeof params?.[ 'protocolVersion' ] === 'string'
			? params[ 'protocolVersion' ] as string
			: PROTOCOL_VERSION;

		return {
			protocolVersion: requested,
			// `listChanged` is a PROMISE THIS SERVER CAN NOW KEEP — see `replaceTools`. Advertising it
			// while the roster was frozen at construction would have been an invitation to re-read a
			// list that could not have changed.
			capabilities:    { tools: { listChanged: true } },
			serverInfo:      { name: this.info.name, version: this.info.version },
		};
	}

	/**
	 * The wire tool surface — the exact array `tools/list` sends, exposed publicly so tooling can read a
	 * built server's surface WITHOUT spawning it over stdio (the promotion script regenerates the committed
	 * `tools.snapshot.json` from this — authoritative by construction, since it is the same projection the
	 * wire uses). No handlers, no protocol framing: just the descriptors a client sees.
	 */
	listTools(): Record<string, unknown>[] {
		return [ ...this.tools.values() ].map( ( t ) => ( {
			name:        t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			// Only emit the key when a tool declares hints — a client sees `annotations` or nothing.
			...( t.annotations ? { annotations: t.annotations } : {} ),
			...( t.example ? { example: t.example } : {} ),
			...( t.doc ? { doc: t.doc } : {} ),
		} ) );
	}

	private onToolsList(): unknown {
		this.listReads.push( new Date().toISOString() );
		return { tools: this.listTools() };
	}

	/** When this process has been asked for its roster. See `listReads`. */
	reads(): string[] {
		return [ ...this.listReads ];
	}

	/**
	 * Swap the whole tool table, and say what moved.
	 *
	 * WHOLESALE, NEVER MERGED. `registerTool` is last-wins, so replaying it over a live table updates
	 * and adds but can never REMOVE — a tool deleted from source would answer from the old closure
	 * forever, and "registered" and "still exists in source" would be two facts sharing one value. The
	 * map is therefore rebuilt from nothing.
	 *
	 * THE CALLER DECIDES WHETHER TO NOTIFY, and it should only do so on a real difference: a
	 * notification that fires when nothing changed is how a client learns to ignore them.
	 *
	 * `revised` IS NOT A REFINEMENT, IT IS THE COMMON CASE. The roster a client caches is a set of
	 * DESCRIPTORS, not a set of names, so editing an existing tool's schema or description leaves the
	 * client just as stale as adding one — and editing beats adding by a wide margin in a nursery.
	 * Comparing names alone would report `changed: false` over exactly that edit, which is this
	 * project's named defect installed in the mechanism built to cure it.
	 */
	replaceTools( defs: ToolDefinition[] ): { added: string[]; removed: string[]; revised: string[]; changed: boolean } {
		// The WIRE projection is the right comparison surface: it is precisely what the client holds,
		// so a difference here is a difference the client can observe, and nothing else is.
		const before = new Map( this.listTools().map( ( t ) => [ t[ 'name' ] as string, JSON.stringify( t ) ] ) );

		this.tools = new Map();
		for ( const def of defs ) this.tools.set( def.name, def );

		const after = new Map( this.listTools().map( ( t ) => [ t[ 'name' ] as string, JSON.stringify( t ) ] ) );

		const added   = [ ...after.keys()  ].filter( ( n ) => !before.has( n ) );
		const removed = [ ...before.keys() ].filter( ( n ) => !after.has( n ) );
		const revised = [ ...after.keys()  ].filter( ( n ) => before.has( n ) && before.get( n ) !== after.get( n ) );

		return { added, removed, revised, changed: added.length > 0 || removed.length > 0 || revised.length > 0 };
	}

	/**
	 * Tell the client its roster is stale. A notification carries no id and is owed no reply, so this
	 * is fire-and-forget by protocol — there is no acknowledgement to wait for and no way to learn from
	 * here whether the client acted. That is what `reads()` is for.
	 */
	notifyToolsChanged(): void {
		this.write( { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } );
	}

	private async onToolsCall( params?: Record<string, unknown> ): Promise<ToolResult> {
		const name = params?.[ 'name' ];
		if ( typeof name !== 'string' ) {
			throw new Error( 'tools/call requires a string "name"' );
		}

		const tool = this.tools.get( name );
		if ( !tool ) {
			throw new Error( this.unknownTool( name ) );
		}

		const args = ( params?.[ 'arguments' ] ?? {} ) as Record<string, unknown>;
		return this.invoke( name, args );
	}

	/**
	 * The unknown-tool refusal, naming the whole registered set.
	 *
	 * A bare "Unknown tool: x" tells a caller it was wrong and nothing else, which costs a round trip to
	 * `tools/list` — or, more often, a guess at a second name. The valid set is sitting in `this.tools`
	 * at the moment of the refusal, so the answer travels with the rejection instead of being something
	 * the caller has to go and ask for. Same shape as the ephemeral-link refusal and PathGuard's type
	 * mismatch: name what was wrong, then name what would be right, right here.
	 */
	private unknownTool( name: string ): string {
		return `Unknown tool: ${ name } — this server registers ${ [ ...this.tools.keys() ].join( ', ' ) }`;
	}

	/**
	 * Run a registered tool in-process by name — the dispatch a COMPOSING tool ( e.g. a batch ) uses
	 * without going over the wire. Same contract as a wire call: a handler that throws folds into an
	 * isError result, never propagating. An unknown tool is an isError result too — unlike a wire
	 * tools/call ( which raises a protocol error ), there is no protocol layer here, so a caller can
	 * treat every outcome uniformly as a ToolResult.
	 */
	async invoke( name: string, args: Record<string, unknown> ): Promise<ToolResult> {
		const tool = this.tools.get( name );
		if ( !tool ) return { content: [ { type: 'text', text: this.unknownTool( name ) } ], isError: true };
		try {
			return await tool.handler( args );
		} catch ( e ) {
			return { content: [ { type: 'text', text: errorText( e ) } ], isError: true };
		}
	}

	// ── Wire I/O ──────────────────────────────────────────────────────────────────

	private reply( id: JsonRpcId, result: unknown ): void {
		this.write( { jsonrpc: '2.0', id, result } );
	}

	private sendError( id: JsonRpcId | null, code: number, message: string ): void {
		this.write( { jsonrpc: '2.0', id: id ?? undefined, error: { code, message } } );
	}

	private write( msg: JsonRpcMessage ): void {
		process.stdout.write( JSON.stringify( msg ) + '\n' );
	}
}

function errorText( e: unknown ): string {
	return e instanceof Error ? e.message : String( e );
}

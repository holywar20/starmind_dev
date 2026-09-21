import { Door, isOk } from '../Door';
import type { ToolDefinition, ToolResult } from '../mcp';

/**
 * The DRIVE verbs — the four things a rig does to the app's surface, and deliberately only four.
 *
 * ── WHY THIS IS A SHORT LIST AND NOT A LANE ──
 * `read_state` and `write_state` already reach 395 declared addresses, which is the right shape for
 * READING what the app holds and the wrong shape for DRIVING it: an agent asked to "look at the board"
 * should not first have to learn which of a hundred channels persists a tab. These four are the vocabulary
 * of a person using the app — show me a thing, set up a workspace, press a thing, read what it says — and
 * nothing here reaches past them.
 *
 * ── WHAT IS NOT HERE, ON PURPOSE ──
 * No CSS selector, no script evaluation, no coordinate click, no synthetic keyboard. Each of those turns
 * "drive the app" into "run arbitrary code in the renderer", which is a different capability with a
 * different threat model, and it would arrive here disguised as convenience. `invoke` presses only what a
 * plug-in has DECLARED for the command palette, so the pressable set is one the app maintains for its own
 * reasons — a command that should not be reachable from a rig should not be in the palette either.
 *
 * ── THEY ALL ANSWER WITH THE SAME SHAPE ──
 * `{ page, label, tabs, refused, text? }` — the surface AFTER the verb ran, never a bare acknowledgement.
 * Read `refused` first: it is empty when the verb did what was asked and carries one sentence when it did
 * not. A verb that could only say "accepted" would leave every caller writing a second question.
 *
 * ── THE RENDERER MAY SIMPLY NOT BE THERE ──
 * A dev renderer reloads under HMR constantly. A verb issued mid-reload comes back with `refused` naming
 * the timeout rather than throwing, because "the app was rebuilding" is an ordinary condition of this rig
 * and a caller should retry rather than diagnose.
 */

function ok( value: unknown ): ToolResult {
	return { content: [ { type: 'text', text: JSON.stringify( value, null, 2 ) } ] };
}

function fail( reason: string ): ToolResult {
	return { content: [ { type: 'text', text: reason } ], isError: true };
}

/** Every verb lands the same way: one op on the drive channel, the surface back, refusals kept intact. */
async function drive( op: string, args: Record<string, unknown>, tool: string, write = true ): Promise<ToolResult> {
	const reply = write ? await Door.write( 'dev_drive', op, args ) : await Door.pull( 'dev_drive', op, args );
	if ( !isOk( reply ) ) {
		const detail = 'detail' in reply ? reply.detail : '';
		return fail( `${ tool }: the door did not carry the verb [ ${ reply.outcome } ]. THE APP WAS NOT DRIVEN — this is a fact about the connection, not about the surface.\n\n${ detail }` );
	}
	return ok( reply.value );
}

export function driveTools(): ToolDefinition[] {
	return [

		{
			name:        'show',
			description: 'Put a page on screen, and optionally focus one of its tabs. Answers with what is now showing.',
			annotations: { title: 'Show a surface' },
			example:     { page: 'studio' },
			doc:
				'THE VERB THAT WAS MISSING LONGEST. Every other tool here could read and arrange the app and none '
				+ 'could bring anything into view, so a rig could set a tab up and never look at it. The shell page '
				+ 'is not persisted either — the app boots to Home every time — which means arranging state through '
				+ '`write_state` and restarting does NOT leave you looking at it.\n\n'
				+ 'NAME A PAGE BY ID OR BY LABEL, case-insensitively. Omit `page` entirely for the primary studio, '
				+ 'which is what "just show me the app" means and is minted on demand if none exists.\n\n'
				+ '`tab` matches by id, by KIND ( `tasks`, `chat`, `plan` ) or by name — kind is usually what you '
				+ 'want, because a rig knows what sort of surface it is after and rarely knows the tab id.\n\n'
				+ 'A page or tab that does not exist comes back in `refused`, NAMING WHAT IS ACTUALLY THERE. That is '
				+ 'the answer to the loop this verb exists to end: guessing at a screen you cannot see.',
			inputSchema: {
				type:       'object',
				properties: {
					page: { type: 'string', description: 'Page id or label. Omit for the primary studio.' },
					tab:  { type: 'string', description: 'A tab on that page, by id, kind or name. Omit to leave the focus alone.' }
				}
			},
			handler: ( args ) => drive( 'show', { page: args[ 'page' ], tab: args[ 'tab' ] }, 'show' )
		},

		{
			name:        'desktop',
			description: 'Assemble a named test desktop of tabs, or release it and go back. Answers with what is now showing.',
			annotations: { title: 'Assemble a test desktop' },
			example:     { name: 'boardref-run', tabs: [ { kind: 'tasks', ref: 'default' }, { kind: 'chat', ref: 'AGENT-ID' } ] },
			doc:
				'A WHOLE WORKSPACE IN ONE CALL, and — the half that matters — one that PUTS THE PREVIOUS ONE BACK.\n\n'
				+ 'Arranging a desktop by hand means reading the studio state, editing a tab tree, writing it back, '
				+ 'and remembering to restore it. The last step is the one a test skips, and skipping it leaves the '
				+ 'person\'s app rearranged by a run they did not make. So the restore is this verb\'s job, not the '
				+ 'caller\'s: `{ name, release: true }` removes the desktop and returns to the page you were on when '
				+ 'you minted it.\n\n'
				+ 'IT CAN ONLY RELEASE ITS OWN. `name` is your handle, not the app\'s id — a release names something '
				+ 'this rig minted or it refuses. A verb that took an id could delete a real desktop on a typo, and '
				+ 'the id it would take is one `show` hands you.\n\n'
				+ 'Each tab is `{ kind, name?, ref?, path? }`. `kind` is the plug-in ( `tasks`, `plan`, `chat`, '
				+ '`action_log`, … ) and `ref` is its subject — a project id for a board, a plan key for a plan, an '
				+ 'AGENT id for a chat. A tab whose kind or ref is wrong still opens; it draws its own empty state, '
				+ 'which is usually the more useful failure.',
			inputSchema: {
				type:       'object',
				properties: {
					name:    { type: 'string', description: 'Your handle for this desktop — what you release it by.' },
					tabs:    { type: 'array', description: 'The tabs to open, in order. Each { kind, name?, ref?, path? }.', items: { type: 'object' } },
					release: { type: 'boolean', description: 'Remove the desktop you minted under this name and go back where you were.' }
				},
				required: [ 'name' ]
			},
			handler: ( args ) => drive( 'desktop', { name: args[ 'name' ], tabs: args[ 'tabs' ], release: args[ 'release' ] }, 'desktop' )
		},

		{
			name:        'invoke',
			description: 'Run one command a plug-in declares for the command palette. Answers with what is now showing.',
			annotations: { title: 'Invoke a declared command' },
			example:     { command: 'tasks.open' },
			doc:
				'PRESSING A THING, WITHOUT A CLICK. Every studio plug-in declares its commands for the palette — '
				+ '`tasks.open`, `chat.new`, `plans.open` — and this runs one of them exactly as a person choosing '
				+ 'it from the palette would, through the same broker.\n\n'
				+ 'THAT IS WHY THERE IS NO ALLOWLIST HERE. The pressable set is the app\'s own roster, maintained '
				+ 'for its own reasons, so it cannot drift from what a person can do and there is no second table to '
				+ 'keep in step. A command that should not be reachable from a rig should not be in the palette.\n\n'
				+ 'IT RUNS INSIDE A STUDIO. A command invoked while the app is on Home is refused, naming the page '
				+ 'you are on — call `show` first. An unknown id is refused WITH THE WHOLE ROSTER, because an agent '
				+ 'that guessed has no other way to learn the real name.\n\n'
				+ 'This is not a general click: it reaches commands, not buttons. A control with no command behind '
				+ 'it is not reachable from here, and that is the boundary rather than a gap to fill.',
			inputSchema: {
				type:       'object',
				properties: {
					command: { type: 'string', description: 'The command id, e.g. "tasks.open".' }
				},
				required: [ 'command' ]
			},
			handler: ( args ) => drive( 'invoke', { command: args[ 'command' ] }, 'invoke' )
		},

		{
			name:        'rendered',
			description: 'The text of one named region on screen, plus the surface it sits on. The cheap alternative to a screenshot.',
			annotations: { title: 'Read what is rendered', readOnlyHint: true },
			example:     { of: 'page' },
			doc:
				'WHAT THE APP IS ACTUALLY SAYING, as text you can assert on.\n\n'
				+ 'USE THIS INSTEAD OF `screenshot` FOR ANYTHING YOU MEAN TO CHECK. A shot is tens of kilobytes of '
				+ 'PNG and captures WHATEVER IS ON SCREEN — including a panel you did not mean to read — where this '
				+ 'returns the text of the one region you named, for a rounding error of the budget. Keep the '
				+ 'screenshot for "does this LOOK right", which is a question about pixels and genuinely needs them.\n\n'
				+ 'TWO VOCABULARIES AND NO THIRD. `page` is everything on screen. Anything else names an AFFORDANCE '
				+ '— `chat`, `callout`, `board-ref`, `file-link` — which the chat surface stamps on every decoration '
				+ 'it draws. Those are names the app chose for itself, so an assertion written against one is '
				+ 'written against a contract rather than against markup. There is deliberately no CSS selector.\n\n'
				+ 'A NAME THAT MATCHES NOTHING HANDS BACK WHAT IS THERE, so you can name a real one on the next '
				+ 'call rather than guess again. Long text is cut at 8000 characters and SAYS it was cut.\n\n'
				+ 'Omit `of` entirely to get the surface alone — the page and its tabs, with no text — which is the '
				+ 'cheapest possible "where am I".',
			inputSchema: {
				type:       'object',
				properties: {
					of: { type: 'string', description: '"page", or an affordance name. Omit for the surface with no text.' }
				}
			},
			handler: ( args ) => drive( 'surface', { of: args[ 'of' ] }, 'rendered', false )
		}

	];
}

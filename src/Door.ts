import { request as httpRequest } from 'http';

/**
 * Door — this package's ONE road into a running Starmind.
 *
 * Everything hot goes through here. That is not tidiness: the whole hot half is a proxy, and a proxy
 * with two transports is two proxies that will eventually disagree about what "the app is down" means.
 *
 * ── WHAT THE DOOR IS ────────────────────────────────────────────────────────────────────────────
 *
 * `POST /dev/verb` on Starmind's loopback router, authorized by the dev bearer. It is a GENERIC verb
 * proxy: it takes a bus verb by name and either `request`s it ( awaits a dispatcher's reply ) or
 * `emit`s it ( fires a declared command and returns ). It holds no allowlist, by ruling — this is a
 * testing surface that never ships, and a rig that can only reach what someone remembered to permit
 * is a rig that cannot investigate the thing that broke.
 *
 * `POST /dev/verbs` enumerates what is reachable, in two lists that are deliberately not merged.
 *
 * ── EVERY OUTCOME IS A VALUE, AND THE OUTCOMES ARE NOT COLLAPSED ────────────────────────────────
 *
 * Nothing here throws. That is the load-bearing property, because this seam has FOUR unreachable
 * shapes that a naive client reports as one:
 *
 *   app-down      nothing is listening. The app is not running, or it is running without a fixed
 *                 router port ( plain `npm run dev` ), so the configured address points at nothing.
 *   no-door       something answered and does not know this path. An app on an older build.
 *   unauthorized  the door is there and the token is missing, stale, or bound to a session rather
 *                 than to the dev principal.
 *   unrouted      the app is up, the door works, and no service serves that channel.
 *
 * A DOOR SHUT BY ITS SWITCH wears whichever of the first three fits — see `DOOR_SWITCH` below, which is
 * why all three name it. It is the ordinary state of a fresh checkout, not an exotic one.
 *
 * Folding those into "error" is the recurring defect this plan is written around, arriving at the
 * seam most likely to hit it: four different things to go and fix, reported as one. Each carries its
 * own fix in words, because the reader is a program or an agent about to retry, and what it needs to
 * know first is whether retrying could possibly help.
 *
 * `threw` is a fifth and it belongs to the app, not the transport: the verb was reached, ran, and
 * failed. That is a RESULT. A caller must be able to tell it from never having been reached, because
 * one of them means the test found something and the other means the test did not run.
 */

/**
 * The dev bearer, and THE ONE SETUP DEPENDENCY THIS PACKAGE CANNOT SEE OR FIX.
 *
 * ── IT LIVES IN TWO PLACES AND THEY MUST MATCH ──
 *
 *   1. `starmind/.env`            — loaded by dotenv into the APP, which binds the dev principal to it.
 *                                   This is the half that decides what the door will ACCEPT.
 *   2. the USER or MACHINE environment — inherited by Claude Code, and from there by this process when it is
 *                                   spawned. This is the half that decides what we PRESENT.
 *
 * Nothing sets both. `.mcp.json` does not carry it ( it once did, and that comment outlived the fact );
 * `dev-proxied` does not carry it; no script writes it. A person sets each side by hand, and the two sides
 * are edited months apart in different files by different reasoning.
 *
 * ── WHY IT IS WORTH THIS MANY WORDS ──
 *
 * The failure is silent and misattributed. Every other signal reads healthy — the app is up, the router is
 * listening, the renderer answers — and every hot tool refuses. It looks like a broken rig or a broken app,
 * and it is neither: it is two copies of a shared secret that stopped agreeing. So both refusals below name
 * BOTH homes rather than the variable, because knowing the name of the variable was never the missing part.
 *
 * SET BY A PERSON, NOT GENERATED, deliberately: a token regenerated each run would re-break the static
 * config that reads it, which is the problem it exists to solve. Absent, the hot half simply cannot
 * authenticate, and says so rather than guessing.
 */
const TOKEN_ENV = 'STARMIND_DEV_TOKEN';

/**
 * Where to dial.
 *
 * ── THIS WAS HARDCODED, THEN READ FROM `.mcp.json`, AND IS NOW DECLARED AGAIN ──
 *
 * Worth recording, because the round trip is not a mistake being undone — it is the OWNER of the fact
 * moving twice in one day, and each move was right at the time.
 *
 * It began as a bare constant here, which was wrong: `.mcp.json` was what an external client actually
 * dialled, `scripts/dev/ports.mjs` already derived the pair from it, and its header states the rule
 * this file should have followed — READ THE TRUTH, DO NOT RESTATE IT. So it was changed to read that
 * file. Hours later Phase 4 turned `starmind_dev` into a STDIO server, and Claude Code stopped dialling
 * a port at all. `.mcp.json` no longer holds one, so reading it became deriving a number from a file
 * that does not contain it — a read that silently falls back and looks like it worked.
 *
 * ── THE DUPLICATION IS REAL AND IS NAMED RATHER THAN HIDDEN ──
 *
 * `ports.mjs` declares this same number, and its copy is the one that decides where the app actually
 * listens. This one only decides where to look. They agree today and nothing enforces that they will.
 * The fix is a HANDSHAKE the app writes at boot and this reads — which would also retire the shared
 * token env var and the whole fixed-port arrangement, since a discovered port needs no agreement at
 * all. Filed as an open question on the sub-plan rather than done in passing, because where that file
 * should live is a multi-project question and this is a single-machine dev rig.
 *
 * ── IT STILL PROBES TWO PORTS, AND THAT IS NOW BELT-AND-BRACES RATHER THAN NECESSARY ──
 *
 * There were two arrangements: `npm run dev` put the app wherever `starmind/.env` pinned it, and
 * `npm run dev:proxied` overrode that to `public + 1` so a long-lived proxy could own the public port.
 * WHICH ONE WAS LIVE WAS UNKNOWABLE FROM HERE — the app's env file is loaded by electron-vite into the
 * app's process and nowhere else — so this probes rather than guesses. A proxied app with no proxy in
 * front of it looked exactly like a dead app on the public port, and that shape cost a live debugging pass.
 *
 * THE SECOND ARRANGEMENT NO LONGER EXISTS. The port move went in 2026-09-04 and the proxy itself was
 * deleted 2026-09-06 ( plan item 1.h ), so nothing in the workspace can put the app on the internal port
 * any more — `ports.mjs` declares one port and there is no second consumer of it.
 *
 * THE PROBE IS KEPT ANYWAY, and the reason is about people rather than scripts: a shell opened before the
 * change, a `STARMIND_DEV_PORT` someone exported and forgot, or a checkout predating any of this will all
 * still land on `public + 1`. Finding that costs one connect against a closed socket, while failing to
 * find it costs a debugging pass — so the asymmetry pays for the probe long after the arrangement is gone.
 * It retires when a stale checkout is no longer plausible, not on a date.
 *
 * ── THE PORT IS NOW A DECLARED SETTING, WHICH RETIRES THE GUESS ON ONE OF THE TWO ROADS ─────────
 *
 * `STARMIND_DEV_PORT` is declared as a config field in this server's MANIFEST, so when Starmind spawns
 * it the variable is always present — a person's answer if they gave one, and the manifest's own default
 * if they did not. On that road `candidates()` returns exactly one port and nothing is probed: the
 * address stops being inferred and becomes a thing somebody decided, visible on a surface, changeable
 * without editing a file.
 *
 * THE FALLBACK BELOW IS FOR THE OTHER ROAD and is not dead weight. Run standalone — `npm start`, or
 * spawned by a plain `claude` session through the repo's `.mcp.json` — nothing injects the variable and
 * the probe is still the only way to find the app. So `PUBLIC_PORT` is now the STANDALONE default rather
 * than the only one, and it agrees with the manifest's by hand. That is one more home for the number than
 * anybody wants ( `ports.mjs` already counts them and proposes the boot handshake that retires all of
 * them ) — named here rather than hidden, because the honest cost of settling for a setting is that the
 * default has to be written twice.
 */
const PORT_ENV     = 'STARMIND_DEV_PORT';
const PUBLIC_PORT  = 51789;

/**
 * THE DOOR IS SHUT BY DEFAULT, and this sentence is why every unreachable outcome carries it.
 *
 * Ruled 2026-09-29: the app refuses the dev lane unless `STARMIND_DEV_DOOR` in `starmind/.env` names a
 * date — the last day it opens — and that date is today or inside a one-week window. Absent, expired or
 * dated too far ahead, the app binds no dev principal and no fixed port, so from OUT HERE a shut door is
 * indistinguishable from an app that is down, on an old build, or holding a different token.
 *
 * WHICH IS EXACTLY WHY IT RIDES ALL THREE. A closed-by-default door is going to surprise somebody the
 * first week, and this package cannot tell which of the three shapes it produced — so rather than guess,
 * every reply that means "never reached" names the switch. One extra sentence against a lost afternoon.
 */
const DOOR_SWITCH =
	'IF THIS IS A FRESH CHECKOUT, THE DEV DOOR IS SHUT BY DEFAULT ( ruled 2026-09-29 ): the app binds no ' +
	'dev principal and no fixed port unless STARMIND_DEV_DOOR in `starmind/.env` names the last day it ' +
	'opens, as YYYY-MM-DD, today or up to 7 days ahead. It EXPIRES on its own, so a door that worked last ' +
	'week is shut this week by design. Set it and restart the APP — main-process code does not hot-reload. ' +
	'A packaged build refuses regardless of the switch.';

/** How long to wait on the app. Generous, because a verb may do real work; well below the MCP client
 *  timeout, because a call that outlives its caller reports its answer to nobody. */
const TIMEOUT_MS = 30_000;

export type DoorReply =
	/** The verb ran. `undefinedValue` separates "returned nothing" from "returned null" — the door asks
	 *  the bus whether the verb ROUTES before calling, so this really is a value and not a miss. */
	| { outcome: 'ok';           verb: string; value: unknown; undefinedValue: boolean }
	/** An emit was accepted. Fire-and-forget by design: the bus event returns before the work does. */
	| { outcome: 'accepted';     verb: string }
	| { outcome: 'app-down';     verb: string; detail: string }
	| { outcome: 'no-door';      verb: string; detail: string }
	| { outcome: 'unauthorized'; verb: string; detail: string }
	| { outcome: 'unrouted';     verb: string; detail: string }
	/** Pull lane. `unregistered` = not a declared read/write on that channel ( a fact about the
	 *  source ); `unarmed` = declared but nothing serving it in THIS run ( a fact about this boot );
	 *  `write-refused` = declared, real, SERVED — and reached through a read-only call. Three separate
	 *  answers because `PullGate.dispatch` gives all three as a bare null. */
	| { outcome: 'unregistered'; verb: string; detail: string }
	| { outcome: 'unarmed';      verb: string; detail: string }
	| { outcome: 'write-refused'; verb: string; detail: string }
	// SEALED — a channel this door is closed to BY DESIGN, not a fault to diagnose. Its own outcome
	// rather than folding into `unregistered`, because "refused on purpose" and "never existed" reading
	// the same is precisely what a capability boundary must never do.
	| { outcome: 'sealed';       verb: string; detail: string }
	| { outcome: 'undeclared';   verb: string; detail: string }
	| { outcome: 'rejected';     verb: string; detail: string }
	| { outcome: 'threw';        verb: string; detail: string }
	/** The door answered a shape this client does not understand — a version skew, not a failed call.
	 *  Named rather than folded into `threw`, because the fix for it is in THIS file. */
	| { outcome: 'malformed';    verb: string; detail: string };

/**
 * WHICH APP ANSWERED — read off the `X-Starmind-App` header the dev door stamps on every reply.
 *
 * ── WHY THIS IS NOT A DETAIL ────────────────────────────────────────────────────────────────────
 *
 * Only an UNPACKAGED Starmind opens the dev door ( `DevLane.endpoint` returns a dead pair when
 * `app.isPackaged` ). So on a machine running two copies — a packaged one that keeps state and hosts the
 * agents, and a throwaway dev one under test — an agent asking this rig anything is reading a process it
 * is not running in. Every answer is honest; every answer is about somewhere else.
 *
 * That is the intended arrangement, which is precisely why it needs saying on every reply rather than in a
 * document somebody remembers. `read_state` against the wrong app returns real trace lines about code
 * nobody is editing, and nothing in the reply would have said so.
 *
 * `pid` AND `port` together are the identity: a port is reused across a restart, and a pid says nothing
 * about which door it opened.
 */
export interface AppStamp {
	pid:      number;
	port:     number;
	packaged: boolean;
	uptimeMs: number;
}

/** One line naming the app, for a reply a person or an agent reads. Null when nothing has answered yet —
 *  which is itself worth saying, because it means no claim about any app has been made. */
export function describeApp( app: AppStamp | null ): string {
	if ( !app ) return 'No app has answered yet, so nothing here describes one.';
	return `Answered by Starmind pid ${ app.pid } on port ${ app.port } `
		+ `( ${ app.packaged ? 'PACKAGED' : 'unpackaged' }, up ${ Math.round( app.uptimeMs / 1000 ) }s ). `
		+ 'This is the app the dev door is open on — NOT necessarily the one hosting you.';
}

/** Narrowing helper, so a caller writes `isOk( r )` rather than restating the discriminator in nine
 *  places and eventually getting it subtly wrong in one of them. */
export function isOk( reply: DoorReply ): reply is Extract<DoorReply, { outcome: 'ok' }> {
	return reply.outcome === 'ok';
}

/** True when the app was never reached, so no verb ran and nothing was tested. Every hot tool branches
 *  on exactly this. ONE predicate rather than three comparisons repeated nine times — otherwise a
 *  fourth unreachable state gets handled in six places and missed in three. */
export function unreached( reply: DoorReply ): boolean {
	return reply.outcome === 'app-down' || reply.outcome === 'no-door' || reply.outcome === 'unauthorized';
}

export const Door = new class Door {

	/** The port that answered most recently. Tried first on the next call, so the ordinary case is one
	 *  connect. Not persisted and not trusted: a restart can move the app between arrangements, and a
	 *  refusal simply sends the probe back through the full candidate list. */
	private _lastGood: number | null = null;

	/** WHO answered most recently, off the header. Null until something has. Overwritten on every reply
	 *  rather than cached once, so a restart that changes the pid is visible on the next call instead of
	 *  the next process — which is the case this exists to catch. */
	private _reached: AppStamp | null = null;

	/** The app the last reply came from. Read by every hot tool as it formats, so no tool has to remember
	 *  to ask and none can report on an app without naming it. */
	get reached(): AppStamp | null {
		return this._reached;
	}

	/**
	 * THE PORT A SETTING NAMES, or null when nothing named one.
	 *
	 * Split out from `candidates` because two different readers want it: the walk, which stops at one port
	 * when it has an answer, and the `app-down` reply, which has to say WHERE a person can change it. A
	 * reply that named a port without saying whether anybody chose it sends the reader to the wrong file.
	 *
	 * Range-checked here rather than trusted. A non-numeric or out-of-range value falls back to the probe
	 * instead of dialling nothing — the same reading `DevLane.endpoint` makes of a bad port on the app's
	 * side, so a typo costs the fixed address rather than the whole road.
	 */
	configured(): number | null {
		const raw = process.env[ PORT_ENV ];
		const set = raw ? Number( raw ) : NaN;
		return Number.isInteger( set ) && set > 0 && set < 65536 ? set : null;
	}

	/**
	 * Where to try, in order. A configured port is taken as the whole answer — somebody who named one is
	 * not asking to be second-guessed, and since the manifest declares a default that is now the ordinary
	 * case rather than the exception. Otherwise both arrangements are candidates; see the note above
	 * `PORT_ENV` for why the probe survives.
	 */
	candidates(): number[] {
		const set = this.configured();
		if ( set !== null ) return [ set ];

		const pub  = PUBLIC_PORT;
		const list = [ pub, pub + 1 ];
		// Whatever answered last goes to the front rather than being appended — it is the best guess,
		// and it is already in the list.
		return this._lastGood ? [ this._lastGood, ...list.filter( ( n ) => n !== this._lastGood ) ] : list;
	}

	/** The address most recently reached, or the first candidate when nothing has been. For messages. */
	get url(): string {
		return `http://127.0.0.1:${ this._lastGood ?? this.candidates()[ 0 ] }`;
	}

	/** Ask a verb and wait for its reply. */
	request( verb: string, ...args: unknown[] ): Promise<DoorReply> {
		return this._call( 'verb', { verb, args, mode: 'request' }, verb );
	}

	/**
	 * Fire a declared command and return.
	 *
	 * `unchecked` skips the door's validation against the command's declared schema. It exists for the
	 * one experiment that needs it — proving what the app does with a payload the Bridge would have
	 * dropped — and defaults off, because behaviour proved under an input the real lane cannot produce
	 * is not behaviour proved.
	 */
	emit( verb: string, payload: unknown, unchecked = false ): Promise<DoorReply> {
		return this._call( 'verb', { verb, args: [ payload ], mode: 'emit', unchecked }, verb );
	}

	/** The three registries, unmerged: bus channels SERVED, IPC commands DECLARED, and the pull lane. */
	verbs(): Promise<DoorReply> {
		return this._call( 'verbs', {}, '/dev/verbs' );
	}

	/**
	 * The other half of `verbs` — what the app's source CALLS, judged against what it serves.
	 *
	 * THE APP DOES THE WORK AND THAT IS THE POINT. Both halves of the comparison live over there: the
	 * routing rule that decides which channel a verb reaches ( `pkg.<name>` nests a level deeper than a
	 * floor verb ) and the live registry with each channel's declared ops. Scanning the source from here
	 * would mean keeping a second copy of that routing rule in this package, and a second copy of the
	 * namespace layout is a check that silently stops covering package verbs the day the layout moves.
	 *
	 * Same arrangement as every other tool here: this file keeps no list and derives no rule.
	 */
	calls(): Promise<DoorReply> {
		return this._call( 'calls', {}, '/dev/calls' );
	}

	/**
	 * Read state off the pull lane — the second door, and the one that reaches the other 14 services.
	 *
	 * ELEVEN SERVICES SERVE A BUS CHANNEL; the rest declare only a pull channel and are invisible to
	 * `request`. Nothing was added to any service to make this work: the pull registry and the gate that
	 * validates against it already existed for the renderer, and this speaks the same envelope.
	 *
	 * READS ONLY — A LANE, NOT A LIMIT. The door serves writes ( see `write` below ); this method simply
	 * does not ask for one, so a write op reached through it comes back `write-refused` instead of being
	 * performed. That is the whole guarantee behind the name: a caller reading state cannot change it by
	 * mistyping an op, and a tool called `read_state` cannot become a mutation under a reader's nose.
	 */
	pull( channel: string, op: string, args?: unknown ): Promise<DoorReply> {
		return this._call( 'pull', { channel, op, args }, `${ channel }.${ op }` );
	}

	/**
	 * WRITE state through the pull lane — the ARRANGE half, and the half the rig lacked longest.
	 *
	 * The same envelope, the same gate, the same `PullGate.dispatch` the renderer's IPC handler calls; the
	 * only difference is that this one opts in. `Channels` declares 121 writes against 96 reads, so the
	 * mutating vocabulary is the LARGER half of the lane and a suite without it can assert far more than
	 * it can set up — which leaves every test inheriting whatever state the app happened to be in.
	 *
	 * RULED 2026-08-24, and what retired the refusal was that it was lane-shaped rather than
	 * capability-shaped: `room_store` serves its writes on the BUS, so `room_store.delete` was reachable
	 * through `request` the entire time the identical op was refused here. This makes the two lanes agree
	 * rather than opening anything that was genuinely shut.
	 *
	 * NOT GOVERNED, AND DELIBERATELY SO. Nothing below this door checks a principal — not for this caller
	 * and not for the renderer. What stands in for governance is that every call traces under its own verb
	 * and that the door never ships. Both are recorded on the automation-suite plan, the second as a
	 * constraint with an undecided mechanism rather than as something already handled.
	 */
	write( channel: string, op: string, args?: unknown ): Promise<DoorReply> {
		return this._call( 'pull', { channel, op, args, allowWrites: true }, `${ channel }.${ op }` );
	}

	/**
	 * Call a TOOL, judged against a passport.
	 *
	 * THE ONLY LANE ON THIS DOOR THAT IS GOVERNED. Every other reaches a bus verb or a pull op with nothing
	 * below it checking who asks; this one goes through the same `ToolGate` a real turn crosses, so what
	 * comes back is a verdict rather than just a result.
	 *
	 * `asSession` names a RUN whose papers to present. Omitted, the call is judged against the dev
	 * principal, which holds `allow` on every tool the app serves — so the borrow NARROWS to one run's
	 * reach rather than granting anything. That is the assertion worth making: not that this key is
	 * powerful, but that a live agent policy constrains a call.
	 *
	 * Unborrowed, the call STANDS IN A PROJECT — `asProject`, else the app's default — and takes that
	 * project's reach and denials, so a documentation tool has a vault to open. That is the operating road;
	 * `asSession` is the testing one. Name one or neither, never both.
	 */
	callTool( tool: string, args?: Record<string, unknown>, asSession?: string, asProject?: string ): Promise<DoorReply> {
		return this._call( 'tool', {
			tool, args: args ?? {},
			...( asSession ? { asSession } : {} ),
			...( asProject ? { asProject } : {} )
		}, tool );
	}

	/**
	 * Is the app actually up, and is its window showing anything.
	 *
	 * THE FIRST CALL TO MAKE, and it earned that status by this package moving out of process. When the
	 * dev surface was a tenant of the app, any tool replying at all proved the app was alive. A
	 * standalone server answers whether or not Starmind exists, so a reply now proves nothing about it.
	 * This op is the only one whose success IS the statement that the app is up.
	 */
	status(): Promise<DoorReply> {
		return this._call( 'status', {}, '/dev/status' );
	}

	/**
	 * Relaunch the app. Returns as soon as the quit is scheduled.
	 *
	 * NEW PHYSICS, AND THIS IS THE TOOL THAT GAINED THE MOST FROM THE MOVE. In process, this killed the
	 * server serving the call, so nothing could observe the outcome — a caller had to leave and come
	 * back. From out here the caller survives its own restart, so `restart` then `status` is a sequence
	 * that can actually be written down and asserted on. That is the loop an unattended run needs: apply
	 * a main-process change, restart, CONFIRM it came back, continue.
	 */
	restart(): Promise<DoorReply> {
		return this._call( 'restart', {}, '/dev/restart' );
	}

	private async _call( op: string, body: object, verb: string ): Promise<DoorReply> {
		const token = process.env[ TOKEN_ENV ];
		if ( !token ) {
			return { outcome: 'unauthorized', verb, detail:
				'No ' + TOKEN_ENV + ' in this process environment, so there is no bearer to present. THIS HALF ' +
				'IS INHERITED: this server is spawned by the MCP client, so the variable has to be in the ' +
				'environment that started the client — setting it in a shell afterwards reaches nothing, and ' +
				'the client must be restarted to pick it up. The app reads its own copy from `starmind/.env`, ' +
				'and the two must match. It is set by a person on purpose: a token regenerated each run would ' +
				're-break the static config that reads it.' };
		}

		const raw = await this._post( '/dev/' + op, JSON.stringify( body ), token, verb );
		if ( 'outcome' in raw ) return raw;                        // the transport already decided

		let json: Record<string, unknown>;
		try { json = JSON.parse( raw.text ) as Record<string, unknown>; }
		catch { return { outcome: 'malformed', verb, detail: `The door answered ${ raw.status } with text that is not JSON: ${ raw.text.slice( 0, 200 ) }` }; }

		if ( raw.status === 401 ) {
			return { outcome: 'unauthorized', verb, detail:
				`The door refused the bearer in ${ TOKEN_ENV }. THE TWO COPIES DISAGREE: the app binds the dev ` +
				'principal to the value in `starmind/.env`, this server presents the value it inherited from ' +
				'the environment that started the MCP client, and nothing keeps them in step. Compare those ' +
				'two. Either is also STALE-able — the app reads its copy once at startup, so a value edited ' +
				'since then will not match until the app restarts, and this side is fixed at spawn. ' +
				'The remaining case is a token bound to a session rather than to the dev principal. ' + DOOR_SWITCH };
		}
		if ( raw.status === 404 ) {
			return { outcome: 'no-door', verb, detail:
				`Something is listening on ${ this.url } and does not serve /dev/${ op }. Most likely an app ` +
				'running a build from before the door existed — main-process code does not hot-reload, so this ' +
				'needs a full restart rather than an HMR pass. A 404 is ALSO what a non-dev caller gets, ' +
				'deliberately: the class refusal is made indistinguishable from an unknown path. ' + DOOR_SWITCH };
		}
		if ( raw.status !== 200 ) {
			return { outcome: 'malformed', verb, detail: `The door answered ${ raw.status }: ${ raw.text.slice( 0, 200 ) }` };
		}

		// ── The app answered. Now the app's own outcomes. ──
		// THE PULL OP answers in the same shape as a verb call — a value, with the same undefined/null
		// separation — so it is read the same way rather than needing its own branch downstream.
		if ( op === 'pull' ) {
			if ( json[ 'ok' ] === true ) return { outcome: 'ok', verb, value: json[ 'value' ], undefinedValue: json[ 'undefinedValue' ] === true };
		} else if ( op !== 'verb' ) {
			// THE HOST OPS answer with their payload spread at the top level rather than under `value`,
			// since they are facts about the app rather than a call's return. Handed back whole.
			return { outcome: 'ok', verb, value: json, undefinedValue: false };
		}

		if ( json[ 'ok' ] === true ) {
			if ( json[ 'mode' ] === 'emit' ) return { outcome: 'accepted', verb };
			return { outcome: 'ok', verb, value: json[ 'value' ], undefinedValue: json[ 'undefinedValue' ] === true };
		}

		const detail = String( json[ 'detail' ] ?? json[ 'error' ] ?? 'the door gave no detail' );
		switch ( json[ 'reason' ] ) {
			case 'unrouted':           return { outcome: 'unrouted',      verb, detail };
			case 'unregistered':       return { outcome: 'unregistered',  verb, detail };
			case 'unarmed':            return { outcome: 'unarmed',       verb, detail };
			case 'write-refused':      return { outcome: 'write-refused', verb, detail };
			case 'sealed':             return { outcome: 'sealed',        verb, detail };
			case 'undeclared-command': return { outcome: 'undeclared', verb, detail };
			case 'schema-rejected':    return { outcome: 'rejected',   verb, detail };
			case 'threw':              return { outcome: 'threw',      verb, detail };
			default:                   return { outcome: 'malformed',  verb, detail: `Unknown refusal reason "${ String( json[ 'reason' ] ) }": ${ detail }` };
		}
	}

	/**
	 * POST at each candidate in turn, first answer wins.
	 *
	 * A REFUSAL ON ONE PORT IS NOT AN ANSWER, it is a port to cross off. Only when every candidate
	 * refuses is the app genuinely unreachable, and only then does `app-down` get reported — with the
	 * ports actually tried, because "nothing is listening" is a claim a reader should be able to check.
	 *
	 * Anything OTHER than a refusal ends the walk immediately, including a 401 or a 404. Something is
	 * listening there and it is Starmind's router; moving on to the next port after a real reply would
	 * turn "your token is wrong" into "the app is down", which is the exact collapse this file exists to
	 * prevent.
	 */
	private async _post( path: string, body: string, token: string, verb: string ): Promise<DoorReply | { status: number; text: string }> {
		const tried: number[] = [];
		for ( const port of this.candidates() ) {
			tried.push( port );
			const got = await this._postTo( port, path, body, token, verb );
			if ( got === 'refused' ) continue;
			this._lastGood = port;
			return got;
		}

		// WHERE THE ADDRESS CAME FROM decides which half of this reply is useful. A CONFIGURED port means
		// somebody's answer is wrong or the app is down, and the fix is a field on a surface. An unconfigured
		// one means we guessed, and the reader needs to know that before they go looking for a setting that
		// was never set. Two different next actions, so they are two different sentences.
		const set   = this.configured();
		const where = set !== null
			? `Port ${ set } is CONFIGURED — it is this server's \`${ PORT_ENV }\` setting, which you can change ` +
			  'on its card in Servers & Tools ( saving restarts the server, so the new port is live at once ). ' +
			  'If that is the right port, the app is not listening on it.'
			: `Nothing configured this port, so it was GUESSED: ${ tried.join( ', ' ) } are the two arrangements ` +
			  'this rig has ever used. Set the port on this server\'s card in Servers & Tools to stop guessing. ' +
			  'Spawned standalone rather than by Starmind, there is no card — export ' + PORT_ENV + ' instead.';

		return { outcome: 'app-down', verb, detail:
			`Nothing is listening on 127.0.0.1 at any of: ${ tried.join( ', ' ) }. ${ where } ` +
			'THE APP\'S OWN HALF IS SEPARATE: it binds what `starmind/.env` sets as STARMIND_ROUTER_PORT, and an ' +
			'unset value means an EPHEMERAL port, which no fixed address can reach — so an app that started fine ' +
			'can still be unreachable from here, and that is a configuration fact rather than a crash. ' +
			DOOR_SWITCH + ' NO VERB RAN, so nothing was tested.' };
	}

	/**
	 * Take the app stamp off a reply's headers, or leave the last one standing.
	 *
	 * PARSED DEFENSIVELY because it is a header: a proxy may fold it into an array, an older app sends none
	 * at all, and a malformed one must not take down a call that otherwise succeeded. A header we cannot
	 * read is the same fact as one that was not sent — nothing new was learned — so both leave `_reached`
	 * exactly as it was rather than clearing it to null, which would claim we had stopped knowing.
	 */
	private _noteApp( raw: string | string[] | undefined ): void {
		const text = Array.isArray( raw ) ? raw[ 0 ] : raw;
		if ( !text ) return;
		try {
			const parsed = JSON.parse( text ) as Partial<AppStamp>;
			if ( typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' ) return;
			this._reached = {
				pid:      parsed.pid,
				port:     parsed.port,
				packaged: parsed.packaged === true,
				uptimeMs: typeof parsed.uptimeMs === 'number' ? parsed.uptimeMs : 0
			};
		} catch {
			/* unreadable is the same as unsent — see above */
		}
	}

	/** One attempt at one port. `'refused'` means keep walking; everything else is a verdict. */
	private _postTo( port: number, path: string, body: string, token: string, verb: string ): Promise<DoorReply | { status: number; text: string } | 'refused'> {
		return new Promise( ( done ) => {
			const req = httpRequest(
				{
					host:    '127.0.0.1',
					port,
					path,
					method:  'POST',
					timeout: TIMEOUT_MS,
					headers: {
						'Authorization':  'Bearer ' + token,
						'Content-Type':   'application/json',
						'Content-Length': Buffer.byteLength( body )
					}
				},
				( res ) => {
					// WHO ANSWERED, before anything is read of what they said. Recorded even on a 401 or a 404:
					// those mean the app is THERE and refusing, which is a fact about a specific process, and
					// a reader chasing a bad token needs to know which app's token is bad.
					//
					// An older app sends no header and leaves `_reached` as it was. That is the honest read —
					// nothing new was learned — and `describeApp` says so rather than inventing a pid.
					this._noteApp( res.headers[ 'x-starmind-app' ] );
					let text = '';
					res.setEncoding( 'utf8' );
					res.on( 'data', ( chunk: string ) => { text += chunk; } );
					res.on( 'end',  () => done( { status: res.statusCode ?? 0, text } ) );
				}
			);
			req.on( 'timeout', () => {
				req.destroy();
				// A TIMEOUT IS NOT A REFUSAL and must not send the walk to the next port. Something answered
				// the connection and then took too long, which is a fact about the app rather than about the
				// address — and retrying elsewhere would report it as the wrong thing entirely.
				done( { outcome: 'threw', verb, detail:
					`The app answered on port ${ port } and then did not reply within ${ TIMEOUT_MS / 1000 }s. The ` +
					'verb may still be running — a timeout here says THIS CALL gave up, not that the app did nothing.' } );
			} );
			req.on( 'error', ( err: NodeJS.ErrnoException ) => {
				if ( err.code === 'ECONNREFUSED' ) { done( 'refused' ); return; }
				done( { outcome: 'app-down', verb, detail: `Could not reach 127.0.0.1:${ port }: ${ err.code ?? err.message }. No verb ran.` } );
			} );
			req.end( body );
		} );
	}
}();

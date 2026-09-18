import { StarmindDevServer } from './server';

/**
 * Process entry — serve on stdio.
 *
 * Deliberately almost empty. Argument handling lives where the arguments are used: `--root` is read
 * by `Workspace`, which is the only thing that needs it, rather than being parsed here and threaded
 * down through a constructor that has no opinion about it.
 *
 * A fatal error goes to stderr and exits non-zero. It must never go to stdout — that is the JSON-RPC
 * channel, and a crash message written there is not merely noise, it is a malformed frame that
 * corrupts the stream a client is mid-handshake on.
 */
new StarmindDevServer().run().catch( ( err: unknown ) => {
	process.stderr.write( `starmind_dev: fatal: ${ err instanceof Error ? err.message : String( err ) }\n` );
	process.exit( 1 );
} );

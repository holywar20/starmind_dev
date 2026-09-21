import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * This package's first test config.
 *
 * The `alias` is the third place `@kcd/core` is pointed at kcd_sdk's source — beside tsconfig `paths`
 * for the checker and build.js for the bundler. Three declarations of one fact is one too many and is
 * noted rather than tidied: collapsing them needs a shared config module, which is a change to the
 * build shape rather than to this file.
 */
export default defineConfig( {
	resolve: {
		alias: { '@kcd/core': resolve( __dirname, '..', 'kcd_sdk', 'src', 'core', 'index.ts' ) }
	},
	test: {
		name:        'starmind_dev',
		environment: 'node',
		include:     [ 'src/**/*.test.ts' ],
		exclude:     [ '**/node_modules/**', '**/dist/**' ],

		// ── COVERAGE ──────────────────────────────────────────────────────────────────────────────
		//
		// `all: true` for the same reason as everywhere else: without it an untested file is not
		// counted as uncovered, it is not counted, and the number goes UP as coverage goes down.
		//
		// SHARPEST HERE OF THE THREE. This package is the rig that judges the others, and its own suite
		// covers two files' worth of behaviour against twenty tools. A coverage number that omitted the
		// untested tools would let the instrument report health it does not have — which is the failure
		// this whole plan exists to catch, one level up.
		//
		// No thresholds until there is a baseline — see the automation-suite plan, item 6.c.
		coverage: {
			provider:         'v8',
			reporter:         [ 'text-summary', 'json-summary' ],
			reportsDirectory: './coverage',
			all:              true,
			include:          [ 'src/**/*.ts' ],
			exclude:          [ '**/__tests__/**', '**/*.test.ts', '**/dist/**', '**/*.d.ts' ]
		}
	}
} );

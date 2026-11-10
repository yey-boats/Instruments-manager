# Vendored `@yeyboats/proto` (control protocol client)

This is a committed, self-contained copy of the shared `@yeyboats/proto`
JS library (JSON-Schema validators + version negotiation for the espdisp /
yeyboats device control protocol). Its canonical home is the `instruments`
repo at `proto/js` + `proto/schema`.

## Why it's vendored

The plugin depends on `@yeyboats/proto` via a `file:` path. Upstream that
package lives in a *sibling* repo (`instruments/proto/js`), so a bare clone of
this repo could not resolve it and `npm ci && npm test` failed on any machine
that didn't have the monorepo laid out just so. Vendoring makes the test suite
hermetic: `npm ci` from a fresh clone resolves the dependency with no external
paths.

## Source commit

Refreshed from **yey-boats/instruments@c4a967b85a87a0e3b38ad9bca425f13f1cf2b466**
(`main`, 2026-11-10): `proto/js/{index,validators,version}.js`,
`proto/js/types.d.ts`, `proto/schema/*.schema.json`, `proto/fixtures/*.json`.
`js/package.json` is a trimmed copy (no `gen` script / devDependencies);
`proto/js/test` is not vendored (upstream it still asserts major 1 and fails
against its own v2 schema).

## Protocol major version

This copy pins the **major-2** protocol schema (`x-proto-major: 2`), matching
the firmware's `kProtoMajor = 2` (instruments 3912fce, v0.4.0+). The bump from
1 changed only the schema header (`$id` / `title` / `x-proto-major`); message
shapes are byte-identical. `lib/proto-control.js` speaks `PROTO_VERSION = '2.0'`.

The upstream fixtures still carry `"v":"1.0"`, as does firmware v0.4.x in its
DeviceRecord / acks (while it rejects inbound major 1); see
`LEGACY_RECORD_MAJORS` in `lib/proto-control.js`.

## Freshness

CI's `contract` job checks out yey-boats/instruments `main` and runs
`tools/check-vendored-proto.sh` (byte-compares the vendored files) plus
`INSTRUMENTS_DIR=… node test/proto-contract.test.js` (manager vs the firmware's
schema, fixtures and `kProtoMajor`). Locally:

    tools/check-vendored-proto.sh ../instruments
    INSTRUMENTS_DIR=../instruments node test/proto-contract.test.js

To refresh:

    I=../instruments   # an up-to-date instruments checkout
    cp $I/proto/js/{index,validators,version}.js $I/proto/js/types.d.ts vendor/proto/js/
    cp $I/proto/schema/*.schema.json vendor/proto/schema/
    cp $I/proto/fixtures/*.json vendor/proto/fixtures/

then update the source commit above.

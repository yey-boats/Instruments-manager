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

## Protocol major version

This copy pins the **major-1** protocol schema
(`x-proto-major: 1`), which is the version this plugin's `proto-control.js`
client and its tests target (`versionCompatible('1.0') === true`,
`'2.0' === false`). The `instruments` schema has since bumped to major 2
(rebrand); that bump only changed the schema header (`$id` / `title` /
`x-proto-major`) — the message shapes are byte-identical. When the plugin
migrates to the v2 wire protocol, refresh this vendored copy from
`instruments/proto` and update `proto-control.js`'s `PROTO_VERSION`.

To refresh:

    cp ../../<path-to>/instruments/proto/js/{index,validators,version}.js vendor/proto/js/
    cp ../../<path-to>/instruments/proto/js/types.d.ts vendor/proto/js/
    cp ../../<path-to>/instruments/proto/schema/*.schema.json vendor/proto/schema/

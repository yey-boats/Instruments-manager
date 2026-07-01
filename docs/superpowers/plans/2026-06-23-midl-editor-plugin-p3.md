# P3 — Mount shared <MidlEditor> in the SignalK plugin (mythra-nav)
Reuses the existing midl-preview pattern (global bundle + vanilla mount + SignalK DataProvider).
A: midl editor/vite.global.config.ts -> midl-editor.global.js (window.MidlEditor, all inlined). push origin/feat/midl-editor.
B: plugin: bump midl submodule; build public/midl-editor.global.js; midl-editor.html/js (mount <MidlEditor>,
   store adapter over GET/POST /devices/:id/editor/midl, same-origin SignalK provider, capabilities manifest);
   routes in index.js using lib/midl-adapter + manager.editorLayout/mutateEditorLayout/queueConfigReload.
C: local run.sh smoke. D: deploy compulab@mythra-nav, push to physical device, confirm re-render.

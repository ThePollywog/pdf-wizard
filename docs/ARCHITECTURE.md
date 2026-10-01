# PDF Wizard — Architecture

PDF Wizard is a PDF viewer and editor for administrative paperwork, with CAC digital signing. It runs
**entirely in the browser**: there is no backend. `npm run build` produces a static `dist/` that any
static host can serve. Files are stored in the browser (IndexedDB) and never leave the machine. The
one thing a web page can't do, using the private key on a smart card, goes through a small browser
extension and native helper (`extension/`, `native/`; see Digital signatures below).

```
index.html                  Vite entry → client/src/main.tsx
client/src/
  main.tsx                  bootstrap (shell)
  app/                      application shell: top bar, home, all-tools page, workspace layout (SHELL)
  core/
    types.ts                data model + extension-point interfaces            (CONTRACT – stable)
    registry.ts             plugin registry + feature loader                     (CONTRACT – stable)
    store.ts                zustand app store + actions (undo/redo, objects...)  (CONTRACT – stable)
    geometry.ts util.ts     helpers                                              (CONTRACT – stable)
    library.ts              the file library in IndexedDB (files, versions, thumbnails) (CONTRACT – stable)
    engine/                 pdf.js loading, page ops (pdf-lib), export pipeline  (ENGINE owner)
    viewer/                 document viewer, page layers, selection framework    (VIEWER owner)
    ui/                     UI kit (buttons, modals, menus, color picker…)       (SHELL owner)
  features/<id>/index.ts(x) one folder per feature, registers itself via core/registry.ts
  styles/                   global CSS + theme tokens                            (SHELL owner)
public/fonts/               bundled Unicode fallback fonts (Noto Sans, Droid Sans Fallback; OFL / Apache-2.0)
public/trust/dod-pki.json   DoD PKI certificates (roots + issuing CAs) for checking signatures
extension/                  "PDF Wizard CAC Signing" browser extension (MV3) — relays signing to the helper
native/macos, native/windows  native messaging helper that signs with the smart card (OS keystore)
scripts/                    fixtures generator, signing self-test, dev helpers (dev-time Node only)
fixtures/                   generated sample PDFs used by tests (npm run fixtures)
e2e/                        Playwright tests
```

Stack: React 19 + TypeScript + Vite 8, zustand 5, **pdfjs-dist 6** (rendering, text, forms),
**@cantoo/pdf-lib** (a maintained pdf-lib fork with encryption; import it as `@cantoo/pdf-lib`,
never `pdf-lib`), lucide-react icons, **pkijs/asn1js** (CMS signatures, certificates). Dev-time only
(fixtures, tests): `pdftoppm`/`pdftotext`/`pdfsig` (poppler), `soffice`, `tesseract`, `sharp`.

Do not add npm dependencies without being told to; everything needed is installed.

## Core principles

1. **Base bytes + overlay objects.** Each open document has immutable `bytes` (the page content)
   and a set of editable **overlay objects** (`PdfObject`: annotations, fill&sign marks, added text/
   images, links, redaction marks, form-field drafts, measurements…). Objects are rendered by the
   viewer as DOM/SVG over the page canvas, and are only written into a PDF on export
   (`engine.exportPdf`), as real annotations (with appearance streams) or flattened content.
2. **Page operations rewrite bytes.** Rotate/delete/move/insert/crop/etc. use pdf-lib to produce new
   bytes and call `actions.commitBytes` with the new `PageInfo[]`. Page ids are stable, so objects
   follow their page. The engine reloads pdf.js automatically when `doc.version !== doc.pdfVersion`.
3. **Everything undoable.** Store actions push snapshots (`bytes` shared by reference). Undo/redo is
   synchronous in the store.
4. **Coordinates** in the model are PDF user space (points, y-up, unrotated, absolute). Use
   `core/geometry.ts` (`toView`, `toPdf`, `rectToView`, `viewToRect`) with a pdf.js `PageViewport`.
5. **Features are plugins.** A feature never edits another feature's folder or the core. It registers
   tools, object types, tasks ("All tools" entries), panels, commands, text-selection actions,
   context-menu items, file handlers, import/export hooks through `core/registry.ts`. The loader
   imports every `features/*/index.ts(x)` lazily and isolates failures. During development you can
   load only some features with `?features=comments,fill-sign` (or `localStorage['pdfwizard.features']`).
6. **Form values** (AcroForm) live in the pdf.js `annotationStorage` of the current `doc.pdf`
   while editing; the engine bakes them into bytes (`pdf.saveDocument()`) before any byte change
   and at export time (`engine.commitFormValues`).

## Store (`core/store.ts`) — summary

State: `docs`, `tabs`, `activeDocId`, `route` ('home' | 'tools' | 'document' | 'task'),
`activeTaskId`, `leftPanelOpen`, `rightPanelId`, `activeToolId` ('select' default; 'hand' = pan),
`toolLocked`, `toolOptions[toolId]`, `prefs` (userName, theme…), `modals`, `toasts`, `busy`.

Hooks: `useApp(sel)`, `useActiveDoc(sel)`, `useDoc(id, sel)`, `useToolOptions(toolId, DEFAULTS)`.
Accessors: `getDoc(id)`, `getActiveDoc()`, `requireActiveDoc()`, `objectsOnPage(doc, pageId)`,
`pageIndexOf(doc, pageId)`, `newObject({...})`, `createDocState({...})`.

`actions`: documents (`addDocument, closeDocument, setActiveDoc, updateDoc, markSaved, rename`),
bytes (`commitBytes`), `setMeta`, `setOutline`, `setSecurity`, history (`checkpoint, undo, redo`),
objects (`addObject(s), updateObject(s), deleteObjects, setSelection, setEditing, bringToFront,
sendToBack`), view (`setView, setZoom, zoomIn, zoomOut, fit, rotateView, goToPage,
setDecorations, setExt`), navigation (`setRoute, openTask, setLeftPanelOpen, setRightPanel,
toggleRightPanel, setTool, toolDone, setToolLocked, setToolOption, setPrefs`), UI (`openModal,
closeTopModal, toast, dismissToast, setBusy, withBusy`).

Dragging pattern: call `actions.checkpoint(docId, 'Move')` once at pointerdown, then
`updateObject(..., { checkpoint: false })` on every move. Sliders: pass `{ coalesce: 'opacity:'+id }`.

## Engine (`core/engine/index.ts`) — public API (ENGINE owner implements)

```ts
// setup / sync
initPdfjs(): void                                   // worker, cMapUrl=/pdfjs/cmaps/, standardFontDataUrl=/pdfjs/standard_fonts/, wasmUrl=/pdfjs/wasm/, iccUrl=/pdfjs/iccs/
startEngineSync(): () => void                       // subscribe to store; (re)load pdf.js docs when version changes; destroy stale proxies
setPasswordProvider(fn: (fileName: string, retry: boolean) => Promise<string | null>): void
loadPdfjs(bytes: Uint8Array, opts?: { password?: string }): Promise<PDFDocumentProxy>   // copies bytes (pdf.js detaches buffers)
loadLib(bytes: Uint8Array): Promise<LibDocument>    // @cantoo/pdf-lib load (ignoreEncryption:false, updateMetadata:false)

// opening
openFiles(files: File[]): Promise<DocId[]>          // PDFs directly; other types via registry.fileHandlers; toasts on failure
openBytes(name: string, bytes: Uint8Array, opts?: { fileId?: string | null; activate?: boolean }): Promise<DocId | null>
openFromLibrary(fileId: string): Promise<DocId | null>
readPages(pdf): Promise<PageInfo[]>   readMeta(pdf, bytes): Promise<DocMeta>   readOutline(pdf, pages): Promise<OutlineItem[]>

// page operations (all undoable, all keep page ids / objects consistent)
withLib(docId, label, fn: (lib: LibDocument, pages: PageInfo[]) => Promise<PageInfo[] | void> | PageInfo[] | void): Promise<void>
   // generic byte edit: commits form values, loads pdf-lib, runs fn, saves, commits. If fn returns
   // nothing, pages are re-read and ids kept by index (only valid if page count/order unchanged).
replaceBytes(docId, label, transform: (bytes: Uint8Array, doc: DocState) => Promise<Uint8Array> | Uint8Array, opts?: { dropObjects?: boolean }): Promise<Uint8Array>
   // whole-file transform as one undo step (OCR, compress, digital signing, PDF/A). `bytes` is a copy with form values baked in; page ids/objects kept by index,
   // objects on pages that no longer exist dropped (dropObjects: all cleared — for transforms of an
   // exportPdf() result, which already contains them). Resolves with the committed bytes (e.g. for
   // markPristine after signing).
rotatePages(docId, indices: number[], delta: 90 | -90 | 180): Promise<void>
deletePages(docId, indices: number[]): Promise<void>
movePages(docId, newOrder: number[]): Promise<void>          // newOrder[i] = old index placed at position i
movePagesTo(docId, indices: number[], targetIndex: number): Promise<void>
insertBlankPages(docId, at: number, count?: number, size?: { width: number; height: number }): Promise<void>
insertPdfBytes(docId, at: number, bytes: Uint8Array, pageIndices?: number[]): Promise<void>
insertFiles(docId, at: number, files: File[]): Promise<void> // uses file handlers for non-PDF
duplicatePages(docId, indices: number[]): Promise<void>       // copies objects on those pages too
replacePages(docId, indices: number[], bytes: Uint8Array, sourceIndices?: number[]): Promise<void>
cropPages(docId, indices: number[], box: Rect | { top: number; right: number; bottom: number; left: number }): Promise<void>
extractPagesToBytes(docId, indices: number[], opts?: { includeObjects?: boolean }): Promise<Uint8Array>
newDocumentFromBytes(name, bytes): Promise<DocId | null>      // = openBytes in a new tab

// export
exportPdf(docId, opts: ExportOptions): Promise<Uint8Array>    // full pipeline (see below)
bakeObjects(docId, objectIds: ObjectId[], label: string): Promise<void> // flatten into bytes, remove objects
commitFormValues(docId): Promise<void>
downloadDoc(docId, opts?: { flatten?: boolean; filename?: string }): Promise<void>
saveDoc(docId): Promise<void>            // to the browser library (create or new version); marks saved
saveDocAs(docId, name: string): Promise<void>
printDoc(docId): Promise<void>           // exports flattened PDF, renders pages to images, prints via hidden iframe
markPristine(docId, fileBytes: Uint8Array, opts?: { encrypted?: boolean }): void
   // declare `fileBytes` the document's on-disk file as of now (e.g. right after appending a digital
   // signature): while nothing changes, exports return exactly these bytes (see "Pristine export")

// fonts for exported text (fonts.ts)
fontForText(ctx: ExportContext, text, preferred?: StandardFonts): Promise<PDFFont>
   // `preferred` (default Helvetica) if it encodes `text`, else the first bundled Unicode fallback font
   // that does (UNICODE_FONT_URLS: Noto Sans, then Droid Sans Fallback for CJK; subset CID font) — use it for any user text
encodableText(font, text): string        // unsupported characters → '?' (always pass drawn text through it)
canEncode(font, text): boolean           unicodeFont(ctx): Promise<PDFFont | null>
patchFontkitSubset(font: PDFFont): PDFFont
   // makes a @pdf-lib/fontkit v1 subset serializable by @cantoo/pdf-lib. ctx.customFont already applies
   // it; call it only for fonts you embed yourself (e.g. into a new document you build with pdf-lib)
// ctx.customFont(key, load): memoized per export by `key`. Key bundled fonts by their URL so features
// share one embedded subset: comments, drawing and fill-sign all use
// '/pdfjs/standard_fonts/LiberationSans-Regular.ttf' (Latin, Greek, Cyrillic) as the key.

// text & rendering
getPageText(docId, pageIndex): Promise<PageText>  // cached per pdf proxy
renderPageToCanvas(docId, pageIndex, opts: { scale?: number; width?: number; forPrint?: boolean }): Promise<HTMLCanvasElement>
getThumbnail(docId, pageIndex, width: number): Promise<string>   // object URL, cached per (version, pageId, width)

interface PageText {
  pageIndex: number;
  text: string;                  // items joined; '\n' between lines
  items: { str: string; rect: Rect; fontName: string; fontSize: number; dir: string; transform: number[];
           /** offset of this item in `text` */ start: number }[];
}
/** Precise-enough rects for a character range inside one item (proportional by char count). */
rangeRects(pageText: PageText, start: number, end: number): Rect[]
```

### Export pipeline (`exportPdf`)
1. `commitFormValues` (pdf.js `saveDocument()` if the annotation storage was modified).
2. Load bytes with pdf-lib. Wrap each page's existing content in `q … Q` before drawing (so
   unbalanced graphics state in the original can't displace new content).
3. For each object (z-order) whose type has `exportToPdf`: call it with an `ExportContext`
   (`ctx.annots.add` writes annotation dicts with appearance streams, or flattens when
   `options.flatten`/`purpose==='print'|'bake'`).
4. Registered export hooks, ordered: outline writer (order 100, if `doc.outline` edited), metadata
   (order 200 from `doc.meta`), feature hooks, encryption (order 1000, from `doc.security`; while
   `doc.security` is still the object read at open, the file's original key and /Encrypt entries are
   re-applied so both passwords keep working — `engine/pdfcrypt.ts`).
5. `pdfDoc.save({ useObjectStreams: true })`.

**Pristine export.** When nothing was changed since the file was opened (same version, objects, order,
meta, outline and security; no form values edited; not flattening) and every registered export hook is
either built in or declares `noopWhenUnchanged: true`, `exportPdf` returns the original file
byte-for-byte — digital signatures, incremental updates and XMP stay intact. Set `noopWhenUnchanged`
on your hook when it only writes state that lives in `doc` (so it's a no-op for an untouched doc);
leave it unset if the hook always rewrites something. After producing new file bytes outside the
pipeline (signing), call `engine.markPristine(docId, bytes)`.

### Import
When a PDF is opened, registered import hooks run (e.g. the comments feature imports existing
annotations as editable objects and strips them from the base bytes via `ctx.setBytes`).

**Existing annotations → objects (`core/annotations.ts`, CONTRACT).** Don't write your own import hook
for annotations; register an importer per PDF subtype instead:
```ts
registerAnnotationImporter({ id: 'comments-markup', subtypes: ['Highlight', 'Underline'], priority?: 0,
  import(src: AnnotationSource) { return importedObject<HighlightObj>(src, { kind: 'highlight', data: { quads: src.nums('QuadPoints') } }); } })
```
One core hook (order 50) walks each page's /Annots once, calls the importers (return null = leave the
annotation in the base PDF), attaches `/IRT` replies (flat threads) and review states (`/StateModel Review`)
to the imported parent (`obj.replies`, `obj.status`), strips everything consumed (+ `/Popup`s) from the base
bytes and reloads once. `src` exposes `dict`, `lib`, `page`, `common` (rect, color, fillColor, opacity,
strokeWidth, dash, author, contents, subject, name(NM), createdAt, modifiedAt, flags, hidden) and helpers
`get/text/num/nums/name/color(key)`. `importedObject(src, { kind, data, ...overrides })` fills the common
fields (`imported: true`, id = NM when usable). For appearances you can't regenerate faithfully (stamps,
rich-text FreeText…) store `await src.preserveAppearance()` in `data` and export with
`appearance: await preservedAppearanceSpec(ctx, pa, obj.rect)` — the original /AP is copied and
stretched onto the (moved/resized) rect; works for annotations and flattening.
Grouped annotations: an importer may implement `importGroupMember(primary, member, primarySrc)` to
absorb an annotation that points at one of its objects with `/IRT` + `/RT /Group` (the StrikeOut of an
"Replace text" Caret); return the updated primary to consume the member, or null to leave it in
the base PDF. `importObjectsFromLib(lib, pages)` runs the registered importers over any pdf-lib document
(e.g. one built from an XFDF file) without modifying it and returns the objects (comments' XFDF import).
Subtype ownership (one importer per subtype): comments → Text, Highlight, Underline, StrikeOut, Squiggly,
FreeText, Caret, FileAttachment; drawing → Ink, Square, Circle, Line, Polygon, PolyLine, Stamp;
protect-redact → Redact.
Link and Widget annotations stay in the base PDF (pdf.js renders them live); features that edit them
convert them on demand through `engine.withLib`.

## Viewer (`core/viewer/`) — VIEWER owner

`<DocumentViewer docId />` renders the active document. Per page, stacked layers:
`canvas` (pdf.js render) → `textLayer` (pdf.js TextLayer, class `textLayer`) →
`annotationLayer` (pdf.js AnnotationLayer: links + AcroForm widgets bound to `pdf.annotationStorage`) →
`decorations` (doc.decorations) → `'under-objects'` page layers → `objects` (ObjectTypeDef.Render
in positioned wrappers) → active tool `PageOverlay` → `'over-objects'` page layers → selection handles.

Features rely on these behaviors:
- Tools: `select` (default: click objects to select, drag text to select text; text selection
  shows the popup with registry.textSelectionActions), `hand` (drag to pan). Other tools come from
  features: while a tool is active, its `PageOverlay` is mounted over each visible page.
  If `tool.textSelection` is true the overlay is not mounted over text and `onTextSelected`
  receives the selection when the mouse is released.
- Selection: click / shift-click / marquee; Delete/Backspace deletes; arrows nudge (shift = 10pt);
  Esc clears; Cmd/Ctrl+C/X/V copy/cut/paste objects; Cmd/Ctrl+D duplicates; drag moves,
  8 handles resize (respect `movable/resizable/keepAspectRatio/minSize`, use `translate/resize`).
  Double-click on an `editable` type sets `editingId`.
- A floating **properties bar** above the selection shows the type's `PropertiesBar` + common
  actions (color for types without their own, delete, more menu: bring to front/send to back/
  lock/properties).
- Context menu on objects/pages merges `registry.contextMenus`.
- `view.scrollRequest` is honored; `view.currentPage` is updated while scrolling.
- Zoom: Ctrl/Cmd + wheel and pinch zoom around the pointer; fit width/page on resize.
- Layer visibility: `doc.ext.optionalContent` (`Record<ocgId, boolean>`, set by navigation's Layers
  panel; null = the document's defaults) is passed to pdf.js as the optional-content config of every
  page render. It is view state: not saved into the PDF, and thumbnails ignore it.
- Always-on extension points (the active tool's `PageOverlay` only mounts while that tool is active):
  - `registerPageLayer({ id, order, placement?: 'under-objects' | 'over-objects', Component })` —
    mounted on every rendered page whatever the tool, with the same props as a `PageOverlay`
    (`viewport`, `toPdf`, `toView`, `rectToView`…). Its container is `pointer-events: none`
    (children opt in with `pointer-events: auto`); render null when there's nothing to show. A layer
    that throws is logged and dropped for that page. 'over-objects' (default) paints above objects
    and the tool overlay; 'under-objects' above the page content and decorations.
  - `registerViewerOverlay({ id, order, Component })` — mounted once per `DocumentViewer`, covering
    the viewer without scrolling with the pages (loupe, pan & zoom window, rulers, auto-scroll
    indicator). Props: `docId`, `scroller` (the scrolling element), `pageAt(clientX, clientY)` →
    `{ pageIndex, point }` in PDF space or null over the gaps, `pageClientRect(pageIndex)` (from the
    layout, so it works for pages virtualized away). Same pointer rules as page layers.
- Exports: `DocumentViewer`, `PageThumbnail` (lazy thumbnail image component), `usePageViewport`,
  `getPageElement(docId, pageIndex)` (DOM lookup) and helper hooks.

## UI kit (`core/ui/`) — SHELL owner (import from `@/core/ui`)

```ts
Button({ variant?: 'primary'|'secondary'|'ghost'|'danger'|'accent', size?: 'sm'|'md'|'lg', icon?: IconType, ...buttonProps })
IconButton({ icon, label /* tooltip + aria-label */, active?, size?, ...buttonProps })
Tooltip({ label, children, side? })
Modal({ title, onClose, children, footer?, width?, className? })   // use inside actions.openModal(render)
Menu / Dropdown({ trigger: ReactElement, items: MenuItem[] | (MenuItem | 'divider')[], align? })
showContextMenu(event: { clientX, clientY }, items: (MenuItem | 'divider')[]): void
TextField({ label?, value, onChange(v: string), ...inputProps })   TextArea(...)   NumberField({ value, onChange(n), min, max, step, suffix })
Select<T>({ label?, value: T, options: { value: T; label: string }[], onChange(v: T) })
Checkbox({ label, checked, onChange(b) })   Radio / RadioGroup   Switch
Slider({ label?, value, min, max, step, onChange(n), format?(n) })
ColorPicker({ value, onChange(hex), palette?: string[], allowNone?: boolean })   ColorSwatchButton(...)
SegmentedControl<T>({ value, options: { value: T; label?: string; icon?: IconType }[], onChange })
Tabs({ tabs: { id, label }[], value, onChange })
Spinner, ProgressBar({ value: number | null }), EmptyState({ icon, title, description, action? })
Popover({ anchor, open, onClose, children })   Kbd   Divider   Toolbar   PanelHeader({ title, actions?, onClose? })
FileDropZone({ accept, multiple, onFiles(files: File[]), children? })
// dialog helpers built on actions.openModal
confirmDialog({ title, message, confirmLabel?, danger? }): Promise<boolean>
promptDialog({ title, label, defaultValue?, placeholder?, validate?(v): string | null }): Promise<string | null>
alertDialog({ title, message }): Promise<void>
```
Global CSS classes defined by the shell (`styles/`): theme tokens as CSS variables
(`--bg`, `--bg-elevated`, `--panel`, `--border`, `--text`, `--text-muted`, `--accent` (#1473e6),
`--brand` (#eb1000), `--danger`, `--radius`, `--shadow`, `--font`), plus `.btn`, `.input`,
`.panel`, `.panel-section`, `.muted`, `.row`, `.col`, `.grow`, `.scroll`. Features put their own CSS in
their folder (import `./styles.css`) and prefix classes with the feature id (e.g. `.comments-…`).

## Shell (`app/`) — SHELL owner
- Top bar: logo, Home / All tools / document tabs (close, dirty dot), global "Menu" (hamburger
  listing registry commands grouped by `menu`), help, user avatar (name used as annotation author).
- **Home**: open/upload (drop zone + button), recent files from the browser library (grid/list,
  thumbnails, search, star, rename, delete, open), featured tasks (`task.featured`), home sections.
- **All tools** page: tasks grouped by category, searchable; clicking a task opens it (asking for a
  file first if `requiresDocument` and no document is open).
- **Document workspace**: left panel (All tools list, or the active task's `Panel` with a back
  arrow), quick-tools rail (tools with `quick`), task toolbar (`task.toolbar` tool ids) + tool options
  bar (active tool `OptionsBar`), center (`DocumentViewer` or `task.MainView`), right rail with
  panel icons (registry.panels) and the open panel, floating page-number + zoom control, header with
  file name (rename), save state, undo/redo, print, download, save, send a copy (system share sheet or download).
- Keyboard shortcuts for `commands[].shortcut` and `tools[].shortcut`; drag&drop files anywhere to
  open; `beforeunload` warning when dirty; hash routes `#/`, `#/tools`, `#/file/<fileId>`,
  `#/doc/<docId>`, `#/task/<taskId>`.
- Feature routes: `registerRouteHandler({ prefix: 'sign', open(arg), docHash?(doc) })` claims
  `#/sign/<arg>`; `open` runs on navigation (also on page load — handlers registered during feature
  load are in place before the router starts) and typically opens a document. While `docHash(doc)`
  returns a hash for the active document, the address bar shows it instead of `#/doc/<id>`.
  Reserved prefixes: '', tools, file, doc, task.
- Hidden `<input type="file" data-testid="open-file-input" multiple>` always present (tests use it).
- Library refresh: `core/library.ts` dispatches `window.dispatchEvent(new CustomEvent('pdfwizard:library-changed'))`; Home listens and reloads.
- Core commands (registered by the shell): open, save, save as/download, print, close, undo, redo,
  zoom in/out, actual size, fit width/page, rotate view, next/prev page, first/last page, select-all
  objects, delete selection, preferences.

## Cross-feature contracts (features/)

Ids other features rely on. Keep them stable; pick new orders that don't tie with existing ones
(registry lists are sorted by `order`, and ties keep the registration order, which depends on the
order in which features happen to load).

**Tasks** (`category:id`, featured order on Home in brackets): edit:edit-pdf [3], comment:comment [4],
sign:fill-sign [5], organize:combine-files [6], organize:organize-pages [7], protect:protect [10],
protect:redact [11], comment:drawing, comment:stamp, review:measure, organize:split-pdf,
organize:extract-pages, organize:insert-pages, organize:rotate-pages, organize:delete-pages,
organize:reorder-pages, organize:reverse-pages, organize:page-labels.

**Tools** (plain-key shortcut in brackets):
- core: select [v], hand [h]
- comments: comment-note [s], comment-highlight [u], comment-underline, comment-strikeout,
  comment-squiggly, comment-insert-text, comment-replace-text, comment-textbox [x], comment-callout,
  comment-attach (the Comment toolbar also lists draw-pen, shape-rect and stamp)
- drawing: draw-pen [d], draw-highlighter, draw-eraser, shape-rect [r], shape-ellipse [o],
  shape-line [l], shape-arrow [a], shape-polyline, shape-polygon, shape-cloud, stamp [k],
  measure-distance / measure-perimeter / measure-area [m, cycles]
- fill-sign: fill-text, fill-cross, fill-check, fill-dot, fill-line, fill-circle, fill-date,
  fill-signature, fill-initials
- edit-pdf: edit-content [e], edit-add-text, edit-add-image, edit-link
- protect-redact: redact-mark [y, only registered when free], redact-pages

Quick-tools rail (`quick`): select 1, hand 2, comment-note 10, comment-highlight 11, draw-pen 12,
fill-text 14, fill-signature 15.

**Shortcuts.** Commands are matched before tools. Several commands may share a combo when at most one
is enabled at a time (toggle pairs such as navigation's read-aloud activate/deactivate on mod+shift+y
and pause/resume on mod+shift+c): the first enabled one wins. Tools sharing a plain key cycle.
Navigation owns mod+f (find bar), mod+g / mod+shift+g (next / previous hit) and mod+shift+f (Advanced
Search). Optional shortcuts (navigation's mod+b, mod+alt+p and read-aloud keys; redact's y) are only
registered when no other command or tool has them. Escape: dialogs, menus and pop-ups close through
the UI kit's escape layers (`useEscapeLayer`). Window-level Escape handlers in features (a shape or
edit in progress) check `hasEscapeLayer()` first or act only while their own gesture is running;
everything else handles Escape on its own focused element (find bar input, panels, the organize grid).

**Object kinds** (`category` in brackets):
- comments: note, text-markup, caret, freetext, file-attachment [comment]
- drawing: ink, shape, line, poly, stamp, measure [comment]
- fill-sign: fill-text, fill-mark, signature [fill-sign]
- edit-pdf: content-text, content-image [content]; link [link]
- protect-redact: redaction [redaction]

Every `comment`-category object is listed in the Comments panel.

**file-attachment data.** Owned by comments (a page /FileAttachment annotation with the file embedded
under /FS /EF). Navigation's Attachments panel lists these objects next to the document-level
/EmbeddedFiles, and protect-redact's "Remove hidden information" deletes them. The data is:
```ts
PdfObject<'file-attachment', { fileName: string; mimeType: string; size: number; bytes: Uint8Array;
  description?: string; fileModified?: number /* epoch ms */; icon?; rotate? }>
```

**Right-rail panels** (order): thumbnails 10, bookmarks 20, comments 30, attachments 40, search 50,
layers 60 (layers is registered only while the active document has optional content).

**Context menus** (order): target `page`: edit-pdf.page 5, comments-ctx-page 20, drawing-ctx 30,
fill-sign.page 40, navigation-page-menu 60, protect-redact.page 70. Target `thumbnail`:
organize-thumbnail 50. Its "Extract to a new file…" item (`organize-thumb-extract`) replaces the
Thumbnails panel's own "Extract page" item while organize is loaded.

**Text-selection actions** (order): comments-tsa-highlight 10, -underline 11, -strikeout 12,
-comment 13, protect-redact-redact 60.

**Import and export hooks** added by features: import `navigation-initial-view-read` 900 (after the
core annotation importer at 50); export `navigation-bookmark-dests` 110, `navigation-initial-view` 150,
`navigation-custom-info` 210, all `noopWhenUnchanged`. Annotation importers are listed under Import
above.

**doc.ext keys** shared with the core: `optionalContent` (navigation, see Viewer), `readOnly` (core).

**Digital signatures** (digital-sign): task `sign:digital-sign` [featured 1], tool `digital-sign-place`,
right-rail panel `signatures` (order 70), page layer `digital-sign-here` (order 40, only while the task
is open). Signing goes through `engine.replaceBytes(…, { dropObjects: true })` + `engine.markPristine`,
so the signed file is exported byte-for-byte afterwards.

## Storage (`core/library.ts`) — in the browser

IndexedDB database `pdfwizard`: `files` (FileMeta + version history), `blobs` (`<id>:<version>` → PDF Blob,
the last 10 versions), `thumbs` (first-page PNG rendered with pdf.js in the background). The library
asks for persistent storage (`navigator.storage.persist()`) on the first save so the browser doesn't
evict it. Each origin has its own library; nothing is uploaded anywhere.
```ts
library.listFiles({ q?, starred? }) → FileMeta[] (newest first)   library.getFile(id) → FileMeta
library.createFile(name, bytes) / uploadFile(blob, name?) → FileMeta
library.getFileBytes(id, version?) → Uint8Array                    library.saveFileBytes(id, bytes, name?) → FileMeta (version+1)
library.patchFile(id, { name?, starred? })   library.deleteFile(id)   library.listVersions(id)   library.restoreVersion(id, v)
library.usage() → { used, quota, persisted } | null
FileMeta = { id, name, size, pages, createdAt, modifiedAt, version, starred, thumbnailUrl /* object URL or '' */ }
```
Errors are `LibraryError` (`notFound` for a missing file or version).

## Digital signatures (`features/digital-sign/`)

- `pdf.ts` — lists AcroForm `/Sig` fields; `prepareSignature` appends **one incremental update** (a new
  or existing field, its appearance, a `/Sig` dictionary with a 24 KB zero-filled `/Contents`) in the
  file's own xref format, so the signed bytes of earlier signatures are never touched.
- `cms.ts` — PAdES-B-B (`ETSI.CAdES.detached`) SignedData: signed attributes (contentType,
  messageDigest, signingCertificateV2) are hashed in the browser; only that 32-byte digest is sent to
  the card. Verification with pkijs; chain building against `public/trust/dod-pki.json` (DoD Root CA
  3–6 are pinned by fingerprint in `trust.ts`). No revocation (CRL/OCSP) checking.
- `bridge.ts` — backends: the CAC bridge (window messages ↔ extension ↔ native helper) and, in dev
  builds, a WebCrypto test certificate (`window.__digitalSign.enableTestSigner()`).
- Export keeps signatures valid when only form values changed: pdf.js writes filled values as an
  incremental update, and `exportPdf` returns that (prefix-preserving) file instead of rewriting it.
  Other changes after signing (comments, page edits…) rewrite the file; signing again warns first.
- Encrypted PDFs can't be signed yet (new objects would have to be encrypted with the file key).

## Development & testing

- `npm run dev` → Vite on :5173. `npm run build` → static `dist/`; `npm run preview` serves it.
- Base path: the site may be served from a sub-path (GitHub Pages: `/<repo>/`, set with `BASE_PATH`).
  Fetch public files through `assetUrl('pdfjs/…')` from `core/util.ts`, never `'/pdfjs/…'`. CSS
  `url(/…)` and `index.html` are rewritten by Vite. Deployment: `.github/workflows/deploy-pages.yml`.
- Isolated instance (for parallel work): `scripts/dev-instance.sh <name> <webPort>`, stop with
  `scripts/dev-instance.sh stop <name>`. Each port is its own origin, so its own file library.
- `npm run fixtures` writes sample PDFs to `fixtures/` (sample, form, annotated, scanned, encrypted
  (password `secret`), rotated/cropped, mixed sizes, large, images).
- Playwright (chromium is installed): write scripts/tests that open the app, use
  `page.setInputFiles('[data-testid=open-file-input]', 'fixtures/sample.pdf')`, interact, take
  screenshots (`page.screenshot({ path })`) and look at them. In dev, `window.__app` exposes
  `{ useApp, actions, getActiveDoc, reg }`, `window.__engine` the engine API, `window.__library` the
  file library and `window.__digitalSign` the signing test hooks.
- Typecheck: `npm run typecheck` (client `tsconfig.json`, scripts/e2e `tsconfig.node.json`).
- Tests: `npx playwright test` (browser e2e in `e2e/`, own Vite on :5199; `E2E_WEB_PORT=5301` for a
  second run side by side) and `npx tsx --tsconfig tsconfig.json scripts/sign-selftest.ts` (signs the
  fixtures twice and checks them with poppler's `pdfsig`). Current status, known issues and
  feature-developer notes: [STATUS.md](STATUS.md).

# PDF Wizard: status

This file covers the state of the integrated app: the core (engine, viewer, shell and UI kit, browser file library) and
the feature modules built on it (see [Features](#features)). It is written for developers building on it.
The architecture and the contract files are described in [ARCHITECTURE.md](ARCHITECTURE.md). Read that
first; this file does not repeat it.

| Check | Command | Result |
|---|---|---|
| Client typecheck | `npx tsc -p tsconfig.json --noEmit` | clean |
| Scripts and e2e typecheck | `npx tsc -p tsconfig.node.json --noEmit` | clean |
| Production build | `npx vite build` | clean, no warnings |
| Signing self-test | `npx tsx --tsconfig tsconfig.json scripts/sign-selftest.ts` | 3 fixtures × 2 signatures, all valid in poppler's `pdfsig` |
| Browser end-to-end | `npx playwright test` (`npm run test:e2e`), all features loaded | 137 passed in about 5 min (includes e2e/digital-sign.spec.ts: CAC flow with the dev test certificate) |

## What works in the core

**Home and library** (`#/`)
- Drop zone and the Open button. The library lists files stored in this browser (IndexedDB).
- Library features:
  - list and grid view
  - search
  - Starred filter
  - sorting by last modified, name or size
  - real thumbnails rendered with pdf.js in the background
  - a per-file ⋯ menu: open, rename, star, download, send a copy, delete
- Clicking a file opens it at `#/file/<id>`. A file that is already open switches to its tab.

**Opening files**
- Ways to open:
  - the file input (`open-file-input`)
  - drag and drop anywhere
  - Cmd/Ctrl+O
  - library deep links `#/file/<id>`
- Password-protected PDFs show a password dialog, which retries on a wrong password.
- Encrypted documents are decrypted in memory for editing. They are re-encrypted with the same user
  password and permissions on save and download (AES-256).
- Files that fail to open show an error state instead of crashing. Non-PDF files are routed to
  registered `FileHandler`s. The core registers one for images (PNG, JPEG, GIF, WebP, BMP, AVIF, SVG).

**Viewer**
- **Rendering:**
  - pdf.js 6 canvas at device pixel ratio
  - text layer aligned to the canvas, with drag-selection and a popup for `TextSelectionAction`s
  - annotation layer: internal and external links, AcroForm widgets, existing annotations with their appearances
- **Virtualization:** only pages near the viewport are mounted. The 300-page `large.pdf` keeps ≤ 8 canvases
  alive while scrolling, and its first page paints in about 0.2 s.
- **Zoom:**
  - floating control
  - zoom menu: fit width, fit page, actual size, 50–400 %
  - Cmd/Ctrl+= / − / 0, Cmd/Ctrl+Alt+1/2
  - Ctrl/Cmd+wheel and trackpad pinch around the pointer
  - refits on resize
- **View rotation:** Cmd/Ctrl+Shift+= / −. This rotates the view only; the document is unchanged.
- **Layouts:** single page, continuous, two pages, two pages scrolling. Paged modes flip with the wheel at the page edges.
- **Other view modes:** night mode, read mode, full screen.
- **Navigation:**
  - page box
  - prev/next buttons
  - ←/→, Home/End
  - Go to page… (Cmd/Ctrl+Alt+G)
  - internal links and outline destinations, both going through `actions.goToPage`
- **Overlay-object framework**, ready for features:
  - click, shift-click and marquee selection; 8 resize handles
  - drag to move, arrow nudge (Shift = 10 pt)
  - copy, cut, paste, duplicate, delete
  - context menus and a floating properties bar
  - built-in Select (V) and Hand (H) tools
- `doc.outline` is loaded (nested, with styles). The Bookmarks panel that edits it is part of the navigation feature.

**Page thumbnails** (`features/thumbnails`, right rail)
- Thumbnails render lazily.
- Clicking a thumbnail navigates.
- Selection: Shift/Cmd multi-select and range select.
- Drag to reorder: dropping on the left half of a thumbnail places the page before it, the right half after it.
- Context menu: rotate, insert blank page before or after, duplicate, extract, delete (with confirmation).
  Features add items above these (organize: Replace, Extract to a new file…, Page labels, Organize pages).
  While organize is loaded its Extract dialog replaces the quick "Extract page" download.
- The Delete/Backspace key deletes the selected pages.
- Thumbnail sizes S, M and L.

**Engine: page operations**
- Operations: rotate, delete, move, insert blank, insert PDF or files, duplicate, replace, crop, extract.
- All of them are undoable (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z) and keep page ids, and therefore overlay objects, stable.
- After a delete or extract, link annotations and outline items that pointed at removed pages are dropped
  or cleared, so poppler, desktop viewers and pdf.js see no dangling destinations.

**Saving and export**
- Download: the export pipeline runs objects, then outline and metadata hooks, then encryption.
- Save to the library as a new version. There is also Save as….
- Print: the document is flattened, rasterized and printed through a hidden iframe.
- The document status reads "On this device", "Unsaved changes", "Saving…" or "Saved".
- Form values typed into widgets persist in downloads and saves.

**Sending**
- **Send a copy** exports the document with every change and offers the system share sheet (Mail, Teams,
  AirDrop… where the browser supports sharing files) or a download. There are no share links: nothing
  is ever uploaded.

**Shell**
- Top bar with document tabs; closing a dirty tab asks Save / Don't save / Cancel.
- App menu (☰) with File, Edit, View, Tools and Help, including submenus and shortcut hints.
- Command palette (Cmd/Ctrl+K) searching commands, tools, tasks and files.
- Keyboard shortcuts dialog (`?`).
- Preferences: theme (light, dark, system) and user name, both persisted.
- Toasts, modals and a busy overlay.
- The left panel is toggled with F4. The All tools page is at `#/tools`.

**No server.** `dist/` is a static site. The file library (with the last 10 versions of each file) lives
in IndexedDB, thumbnails are rendered with pdf.js, and the Unicode fallback fonts ship in `public/fonts`.
About shows how much browser storage the library uses.

**Digital signatures** (`features/digital-sign`, see ARCHITECTURE.md)
- Sign an empty signature field of a form ("Sign here" boxes while the task is open) or draw a new field.
- PAdES (`ETSI.CAdES.detached`) signatures, appended as incremental updates: a second signer can fill
  their part of the form and sign without invalidating the first signature (e2e/digital-sign.spec.ts,
  checked with poppler's `pdfsig`).
- The Signatures panel (right rail) verifies every signature: integrity, later changes, certificate
  validity at signing time, and the chain to DoD Root CA 3–6 (bundled DoD PKI certificates).
- The private key operation goes through the "PDF Wizard CAC Signing" extension and the native helper
  (`extension/`, `native/`). Tested on macOS with a real CAC: the extension and helper list the card's
  certificates and the dialog preselects the signature certificate (DOD EMAIL CA). The Windows helper
  is written for the built-in .NET Framework compiler but hasn't been run on Windows yet.

## Features

All seven feature modules load together with no failures (`useRegistry.getState().failed` is empty) and
no console errors. The ids they share (tools, object kinds, panels, menu orders, hooks) are listed in
ARCHITECTURE.md under "Cross-feature contracts". The plain-key and navigation shortcuts don't collide:
the only shared combos are navigation's toggle pairs (read aloud on/off, pause/resume) and the
three measure tools, which cycle on M.

### Comments (`features/comments`)

- **Task** "Comment" (featured 4). Opening it also opens the Comments panel. Its toolbar has the 10
  comment tools plus draw-pen, shape-rect and stamp.
- **Tools:** sticky note (S), highlight (U), underline, strikethrough, squiggly, insert text, replace
  text, text box (X), callout, attach file. Highlight and sticky note are in the quick-tools rail.
- **Text-selection pop-up:** Highlight, Underline, Strikethrough, Add comment, Copy text.
- **Pop-ups:** author, date, text, a reply thread and a review status.
- **Comments panel** (right rail, order 30, count badge):
  - lists every object of category `comment`, from any feature, grouped by page;
  - search, filter, sort and inline editing; clicking a card scrolls to the comment;
  - ⋯ menu: XFDF export and import, Summarize (a new PDF), Hide or show all, Delete all.
- **Object kinds:** note, text-markup, caret, freetext, file-attachment.
- **In the PDF:** real annotations with appearance streams, written through `ctx.annots.add`:
  - Text, Popup, Highlight, Underline, StrikeOut, Squiggly, Caret, FreeText and FreeTextCallout;
  - FileAttachment, with the file embedded under /FS /EF;
  - replies as /IRT, review states as /StateModel, and Replace text as a StrikeOut grouped with the Caret.

  The importers for these subtypes turn the annotations of opened files back into editable objects.
- **Known gaps:**
  - Characters Liberation Sans lacks, such as CJK, are exported in text boxes and summaries as an image
    of the line with invisible text on top. The text stays searchable but is not vector text.
  - On read-only documents the comment buttons still show in the text-selection pop-up; clicking one
    only shows a toast. `TextSelectionAction` has no `enabled` field.
  - Cmd/Ctrl+Z is not handled while focus is inside an open pop-up.
  - Poppler and desktop viewers pivot NoRotate notes differently on rotated pages, so there a note can show up to
    one icon size away from where the app puts it.
  - Attachment dates round-trip with second precision.

### Drawing (`features/drawing`)

- **Tasks:**
  - "Draw & shapes" (`drawing`);
  - "Stamps" (`stamp`), with a stamp palette;
  - "Measure" (`measure`, category review).
- **Tools:** pen (D, quick rail), highlighter, eraser, rectangle (R), ellipse (O), line (L), arrow (A),
  polyline, polygon, cloud, stamp (K), and distance / perimeter / area measurement (M cycles through
  them).
- **Drawing and shapes:**
  - Shift constrains shapes; pen strokes made close together merge.
  - Click-to-add shapes: Enter or a double-click finishes, Backspace removes the last point, Esc cancels.
  - A properties bar sets stroke, fill, opacity, width, dash style and 10 line endings.
- **Stamps:**
  - standard, dynamic (name and date) and sign-here stamps;
  - custom stamps from an image or a PDF page, saved in localStorage.
- **Measurement:** scale and precision settings, snapping, a live readout, CSV export.
- **Object kinds:** ink, shape, line, poly, stamp, measure (all category `comment`, so they are listed in
  the Comments panel).
- **In the PDF:**
  - Ink, Square, Circle, Line, Polygon, PolyLine (with /BE for clouds) and Stamp annotations, with
    appearances that match the screen;
  - measurements with /IT *Dimension and a /Measure dictionary;
  - stamp text in Liberation Sans (Latin, Greek, Cyrillic);
  - a PDF page used as a stamp is embedded once per file.

  The importers for these subtypes bring existing annotations back as editable objects.
- **Known gaps:**
  - Imported stamps keep their original appearance and aren't mapped back to catalog stamps.
  - A click-to-add shape can't span pages.
  - CJK stamp text is exported as an image of the line with invisible text on top.
  - In narrow windows the task toolbar scrolls sideways.
  - Not covered by e2e: the eraser size, CSV export, "Apply scale to all" and some vertex-menu actions.

### Fill & Sign (`features/fill-sign`)

- **Task** "Fill & Sign" (featured 5). A Form fields section appears when the file has AcroForm fields:
  - a field count and Previous / Next;
  - a highlight toggle (required fields get a red outline);
  - Clear form: text, check boxes, radio buttons and choices, in one undoable step.

  Tab and Shift+Tab move between fields.
- **Tools** (no global shortcuts): add text (quick rail), cross, check, dot, line, circle, date,
  signature (quick rail), initials.
- **Signatures:** typed, drawn or from an image (with background removal), saved per user in
  localStorage, and recolorable.
- **Object kinds:** fill-text, fill-mark, signature (category `fill-sign`).
- **In the PDF:** items are always flattened, with no annotations:
  - text becomes real page text, in Helvetica or in embedded Liberation Sans for Greek, Cyrillic and
    extended Latin;
  - marks become vector paths and signatures become images;
  - form values persist in downloads and saves. Items stay editable in the open document after a save.
- **Known gaps:**
  - Items can't be edited again after the flattened file is reopened.
  - CJK text is exported as an image with invisible text on top.
  - Not implemented: snapping to form lines, auto-fitting signatures into /Sig fields, manual image crop.
  - Typed signatures use system script fonts, so on systems without them the styles can look alike.
  - Form-field values with non-WinAnsi characters are saved, but their appearance depends on pdf.js
    and may not render in poppler.
  - The line symbol shows corner handles even though it only resizes horizontally.
  - The read-only notice doesn't update if the document becomes read-only while the panel is open.

### Edit a PDF (`features/edit-pdf`)

- **Task** "Edit a PDF" (featured 3). Its left panel has:
  - Add content: Edit, Text, Image, Link;
  - Format: font, size, color, style, alignment, line and character spacing;
  - Objects: arrange, flip, rotate, crop, replace;
  - Page design, which is disabled ("Soon").
- **Tools:** edit text & images (E), add text, add image, add or edit link.
- **Text:** the page's own text blocks are outlined and edited in place (typing, reflow, move, delete),
  also on rotated pages.
- **Images:** select, move, resize, flip, rotate, crop, replace and delete; arrows nudge (Shift = 10 pt).
- **Links:** web or page links are created and edited; existing /Link annotations are moved and deleted.
- **Undo:** every edit is one undoable byte edit (`engine.withLib`).
- **Object kinds:** content-text, content-image (category `content`), link (category `link`).
- **In the PDF:**
  - base content is rewritten: the old glyphs are removed and the new text is drawn as real, searchable
    text, in a standard font or embedded Liberation Sans;
  - images get a new placement matrix and clip;
  - added text and images become page content; links become /Link annotations.
- **Known gaps:**
  - Page design tools are not built.
  - Text in Type3 fonts, fonts without width information or vertical fonts can't be cut out of the content
    stream. When such a block is edited or moved, the old text is covered with white instead, and the
    original glyphs stay in the file.
  - Characters no available font has are left out, with a notice.
  - There was no separate builder or QA report for this feature; these gaps come from the code and
    from `e2e/edit-pdf.spec.ts` (14 tests).

### Organize (`features/organize`)

- **Tasks:**
  - "Organize pages" (featured 7): a virtualized page grid replacing the viewer;
  - "Combine files" (featured 6, needs no open document);
  - "Split a PDF", "Extract pages", "Insert pages", "Rotate pages", "Delete pages", "Reorder pages",
    "Reverse pages" and "Page labels": lightweight tasks that open the grid with their action
    highlighted.
- **Grid:**
  - Selection: click, Shift, Cmd/Ctrl, marquee, and a Select menu (all, even, odd, portrait,
    landscape, range).
  - Page actions: rotate, delete (deleting every page is refused), insert (blank, from a file, from the
    library, dropped files), drag and drop, Alt+Arrow moves, cut / copy / paste, duplicate, replace.
  - Extract: to a tab, a download or a ZIP, optionally deleting the pages afterwards.
  - Page labels are written to /PageLabels. Undo and redo work throughout.
- **Combine files:** reorder files, expand them into pages and move pages between files. The result is
  `BinderN.pdf`, with one bookmark per file.
- **Split:** every N pages, by size, by top-level bookmarks or by ranges; the output goes to a ZIP, the
  library or tabs.
- **Thumbnails context menu:** adds Replace, Extract to a new file…, Page labels and Organize pages.
- **Keys** (only while the grid has focus): arrows, Shift / Alt+arrows, Home / End, Enter,
  Delete / Backspace, Cmd/Ctrl+A/C/X/V/D, Esc.
- **In the PDF:** page operations go through the core engine, so they are undoable and keep objects,
  links and bookmarks with their pages. Combine keeps forms, links and annotations.
- **Known gaps:**
  - Split by bookmarks uses top-level bookmarks only.
  - Split by size is estimated in whole pages.
  - Replace maps consecutive pages from one starting page only.
  - Grid shortcuts need focus in the grid.
  - The toolbar's own Undo / Redo hide below about 1180 px; the header's undo and redo stay visible.
  - Read-only handling is covered only by simulation, because no fixture is read-only.

### Navigation (`features/navigation`)

- **Find bar** (Cmd/Ctrl+F; Cmd/Ctrl+G and Shift+Cmd/Ctrl+G to step):
  - an "N of M" count;
  - match case and whole words;
  - normalises hyphenation, quotes and ligatures.
- **Right-rail panels:**
  - Bookmarks (20): create, rename (F2), style, drag, set destination, delete with undo; the current
    page's bookmark is highlighted.
  - Attachments (40): document-level embedded files plus comments' file-attachment objects.
  - Advanced Search (50, Shift+Cmd/Ctrl+F): results grouped by page.
  - Layers (60): only for documents with optional content.
- **Document Properties** (Cmd/Ctrl+Alt+P, File menu): description, security, fonts, initial view, custom
  metadata.
- **Read Out Loud** (View menu and a floating control), with sentence highlighting.
- **Page context menu:** New bookmark and Read this page.
- **Object kinds:** none of its own; the Attachments panel lists `file-attachment` objects.
- **In the PDF** (export hooks 110, 150 and 210, all `noopWhenUnchanged`):
  - the outline, with bookmark destinations;
  - the initial view (/PageMode, /PageLayout, /OpenAction, viewer preferences), honoured on open before
    the first paint;
  - custom /Info entries, with UTF-8 names;
  - embedded files under /EmbeddedFiles.
- **Known gaps:**
  - The FullScreen page mode is saved but not honoured on open.
  - Layer visibility is view state: it isn't saved, and thumbnails ignore it.
  - Outline edits within 1.5 s of each other merge into one undo step (the core's grouping window).
  - Read Out Loud highlights are approximate; only the speed can be set. It was tested headless only.
  - A find hit at the very top of page 1 can sit under the find bar.
  - FileAttachment annotations already in a file are listed only when comments imports them.

### Protect & Redact (`features/protect-redact`)

- **Task** "Protect a PDF" (featured 10):
  - an open password with a strength meter;
  - a permissions password with printing, changes and copying restrictions;
  - Restrict editing and Remove security;
  - a security summary.

  All of it is applied through `actions.setSecurity` (undoable) and written as AES-256 by the core
  encryption hook.
- **Task** "Redact a PDF" (featured 11), with a toolbar of mark (Y, registered only when the key is free)
  and mark pages:
  - Marks: from the text selection (a Redact pop-up action), by area, or as whole pages (current, range,
    even / odd).
  - Find & redact: terms and patterns (phone, e-mail, credit card, SSN, date), with results grouped by
    page.
  - Properties: fill, outline, overlay text, FOIA codes.
  - Apply redactions is one undoable step.
  - Remove hidden information: metadata, attachments, annotations, forms, hidden text and layers,
    bookmarks, links / JavaScript, search index, cropped content.
- **Object kind:** redaction.
- **In the PDF:**
  - unapplied marks are /Redact annotations, which import back;
  - Apply removes the text, image pixels, annotations, links and widgets under the marks and rasterizes
    the marked pages (240 dpi for up to 10 pages), with invisible text for the rest of the page.
- **Known gaps:**
  - Rasterized pages lose vector quality and can make files bigger.
  - Invisible text written back after Apply skips non-WinAnsi and vertical text, so that text is no
    longer searchable on redacted pages.
  - Annotations and widgets that intersect a mark are deleted whole.
  - Tagged structure (StructTree) on redacted pages is dropped.
  - Sanitize: "overlapping objects" is not implemented, and the examine counts are approximate.
  - Form-XObject content only partly outside the crop box is kept.
  - Find doesn't OCR scanned pages.
  - Widget /DA may reference /Helv without a /DR entry.
  - Form widgets draw above marks before Apply, and the mark tool's label shows twice in the options row
    (both need core changes).

## Known issues and limitations

- **Feature modules:** seven are built and integrated: comments, drawing, fill-sign, edit-pdf, organize,
  navigation and protect-redact, plus `thumbnails`. See [Features](#features).
  - All tools lists 18 tasks with icons, grouped into Edit, Organize & optimize, Comment,
    Review & compare, Fill & sign, and Protect & redact.
  - Not built yet: convert (to and from PDF), OCR, compress and AI. They would have to run in the browser
    too (e.g. tesseract.js in WASM for OCR; image re-encoding for compression).
  - Edit a PDF's Page design tools (Header & footer, Watermark, Background, Crop pages) are shown
    disabled with a "Soon" tag.
- **Protected PDFs keep their original encryption when saved** (`core/engine/pdfcrypt.ts`).
  - Nothing is lost while the security isn't changed. The file key is recovered from whichever password
    opened the file, or from none, and the save re-uses the original key, /Encrypt entries and /ID.
    Both passwords and /P stay exactly as they were, for RC4-40, RC4-128, AES-128 and AES-256
    (e2e/security.spec.ts).
  - Files with custom crypt filters or EncryptMetadata false get fresh AES-256 from `doc.security`
    instead. So do files where the security was changed in the app.
  - `doc.security` shows the passwords as far as they are known:
    - opened with the open password: the permissions password is unknown;
    - opened with the permissions password: the open password is recovered for RC4/AES-128 files;
    - AES-256 files opened with the permissions password: the open password can't be recovered, so it
      only matters if the user then changes the security (the permissions password stands in for it).
- **Fit width uses the widest page.** After one page is rotated to landscape, fit width sizes every page to that
  width, so portrait pages look smaller. Fit page fits the current page or spread.
- **The library is per browser and per origin.** Clearing site data deletes it; another computer or
  browser doesn't see it. The app asks for persistent storage on the first save.
- **Digital signature limits:** encrypted PDFs can't be signed yet; revocation (CRL/OCSP) isn't
  checked (no network); no RFC 3161 timestamps or long-term validation data; the Windows helper is
  untested; Firefox isn't supported by the extension. Leftover "shared, view only" code paths in the
  shell and features (`doc.ext.readOnly`) are no longer reachable now that share links are gone.
- **Documents that can't be decrypted for editing** (`engine.isReadOnly`) are blocked from editing by every
  feature. No fixture reaches that state, so each feature tested it only by marking an open document
  read-only.
- **Printing rasterizes pages** at print resolution. The output is not vector, and text in it is not selectable.
- **The engine chunk is about 1.9 MB** (776 kB gzip), mostly pdf.js and pdf-lib; the app entry is 401 kB
  (125 kB gzip). Features are lazy-loaded into their own chunks through `import.meta.glob`, from 11 kB
  (thumbnails) to 215 kB (organize).
- **Dev globals:** `window.__app` and `window.__engine` exist only in development builds (`import.meta.env.DEV`).
  The e2e suite must therefore run against the Vite dev server, which the Playwright config does.
- **macOS sleep during long runs** stalls Playwright, and tests fail with 15-minute durations and `page.goto`
  timeouts. When a run takes that long, wrap it: `caffeinate -ims npx playwright test`.

## Notes for feature developers

### Rules

- A feature lives in `client/src/features/<id>/index.ts(x)` and is lazy-loaded automatically.
- It must not edit core files or other features. Failures are isolated and show up in
  `useRegistry.getState().failed`.
- While developing, load only your feature with `?features=<id>,thumbnails`, or
  `localStorage['pdfwizard.features']`.
- Import from `@/core/...`:
  - `registry`, `store`, `types`, `geometry`, `util`, `api`
  - `engine`
  - `viewer`: `PageThumbnail`, `usePageViewport`, `getPageElement`, `scrollToObject`, `useVisiblePages`
  - `ui`: Button, Modal, menus, ColorPicker…
- Coordinates in the model are PDF user space: points, y-up, unrotated. Convert them with `core/geometry.ts`
  or with the helpers passed to overlays (`toPdf`, `toView`, `rectToView`).
- Every change must go through the store actions or engine operations, so it is undoable.
- Use `data-testid` on interactive elements so the e2e suite can drive them.

### Registering a tool, an object type and a task

The example below is a complete, working feature. It was verified in the browser: the task appears in All
tools, its panel activates the tool, dragging on a page creates a selectable and movable object, and the
download contains a `/Square` annotation.

```tsx
// client/src/features/rectangles/index.tsx
import { useRef } from 'react';
import { Square } from 'lucide-react';
import { registerObjectType, registerTask, registerTool } from '@/core/registry';
import { actions, newObject } from '@/core/store';
import { rectFromPoints } from '@/core/geometry';
import { hexToRgb01 } from '@/core/util';
import { Button } from '@/core/ui';
import type { ObjectTypeDef, PageOverlayProps, PdfObject, Point } from '@/core/types';

// 1. Object type: how an overlay object renders, edits and exports.
type BoxObject = PdfObject<'box', { dashed: boolean }>;

const boxType: ObjectTypeDef<BoxObject> = {
  kind: 'box',
  label: 'Rectangle',
  icon: Square,
  category: 'comment',          // 'comment' objects are listed in the Comments panel
  hit: 'shape',                 // only the stroke is clickable; the wrapper ignores pointer events
  // The viewer positions a wrapper at `box` (CSS px); draw inside it. scale = CSS px per PDF point.
  Render: ({ obj, box, scale }) => {
    const sw = (obj.strokeWidth ?? 2) * scale;
    return (
      <svg width={box.width} height={box.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <rect x={sw / 2} y={sw / 2} width={Math.max(0, box.width - sw)} height={Math.max(0, box.height - sw)}
          fill="none" stroke={obj.color ?? '#d92d20'} strokeWidth={sw} style={{ pointerEvents: 'stroke' }} />
      </svg>
    );
  },
  summary: (o) => o.contents || 'Rectangle',
  // Written into the PDF on download/save/print. ctx.annots.add fills Rect, C, CA, T, Contents, NM, M...
  // and flattens automatically for print / bake.
  exportToPdf(obj, ctx) {
    const { x, y, width, height } = obj.rect;
    const w = obj.strokeWidth ?? 2;
    const [r, g, b] = hexToRgb01(obj.color ?? '#d92d20');
    ctx.annots.add(ctx.page(obj.pageId), obj, {
      subtype: 'Square',
      appearance: { ops: `${r} ${g} ${b} RG ${w} w ${x + w / 2} ${y + w / 2} ${width - w} ${height - w} re S` },
    });
  },
};
registerObjectType(boxType);

// 2. Tool: a PageOverlay is mounted over every visible page while the tool is active.
function BoxOverlay({ docId, page, toPdf }: PageOverlayProps) {
  const start = useRef<Point | null>(null);
  return (
    <div
      style={{ position: 'absolute', inset: 0 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = toPdf(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        const a = start.current;
        start.current = null;
        if (!a) return;
        const rect = rectFromPoints(a, toPdf(e.clientX, e.clientY));
        if (rect.width < 4 || rect.height < 4) return;
        actions.addObject(
          docId,
          newObject<BoxObject>({ kind: 'box', pageId: page.id, rect, color: '#d92d20', strokeWidth: 2, data: { dashed: false } }),
          { select: true, label: 'Add rectangle' },   // label = undo history entry
        );
        actions.toolDone();                           // one-shot tools return to Select (unless locked)
      }}
    />
  );
}

registerTool({
  id: 'box', label: 'Rectangle', icon: Square, group: 'shape',
  shortcut: 'r',          // plain keys are ignored while typing in inputs
  order: 10, cursor: 'crosshair', oneShot: true, PageOverlay: BoxOverlay,
  // quick: 5,            // also show it in the left quick-tools rail
  // OptionsBar: ...,     // tool options (use useToolOptions(toolId, defaults) / actions.setToolOption)
  // textSelection: true, onTextSelected(sel) {...}   // for text-markup tools
});

// 3. Task: an entry in "All tools" (and the palette). Opening it shows `Panel` in the left panel and
//    the listed tools in a toolbar above the viewer. `MainView` would replace the viewer instead.
function BoxPanel() {
  return (
    <div style={{ padding: 16 }}>
      <Button onClick={() => actions.setTool('box')}>Draw a rectangle</Button>
    </div>
  );
}

registerTask({
  id: 'draw-boxes',
  label: 'Draw rectangles',
  description: 'Mark areas of a page with rectangles.',
  icon: Square,
  color: '#d92d20',
  category: 'comment',
  keywords: ['shape', 'square', 'box'],
  requiresDocument: true,  // the shell asks the user to open a file first when none is open
  Panel: BoxPanel,
  toolbar: ['box'],
  // featured: 3,          // show as a quick action on Home
  // onOpen() {}, onClose() {},
});
```

Open a task programmatically with `actions.openTask('draw-boxes')`, or navigate to `#/task/draw-boxes`.

The other extension points are in `core/registry.ts`, with types in `core/types.ts`:

| Function | Use it for |
|---|---|
| `registerPanel({ id, label, icon, order, Component, badge? })` | A right-rail panel. The button gets the testid `panel-btn-<id>`. See `features/thumbnails`. |
| `registerCommand` / `registerCommands` | A palette entry, a shortcut (`'mod+shift+x'`) and optionally an app-menu entry (`menu: 'file' \| 'edit' \| 'view' \| 'document' \| 'comment' \| 'tools' \| 'help'`, plus `group` and `order`). |
| `registerTextSelectionAction({ id, label, icon, order, run(selections) })` | A button in the popup shown after the user selects text. Each `selection` carries `text` and a set of line `rects` in PDF space. |
| `registerContextMenu({ id, target: 'page' \| 'object' \| 'thumbnail', items(ctx) })` | Extra context-menu entries. |
| `registerFileHandler({ id, extensions, mimePrefixes?, label, convert(file) })` | Turning non-PDF files into PDF bytes on open or insert. |
| `registerImportHook` / `registerExportHook` | Import hooks run on open and may turn existing annotations into objects with `ctx.addObjects` / `ctx.setBytes`. Export hooks are ordered: objects 0, outline 100, metadata 200, encryption 1000. |
| `registerHomeSection` | Extra content on Home. |

There is no server to add routes to: everything a feature does has to run in the browser (WASM and
Web Workers are fine). Store files through `core/library.ts`.

### pdf.js v6 gotchas

- `PDFDocumentProxy.destroy()` **no longer exists**. Destroy the document through its task:
  `pdf.loadingTask.destroy()`, or `destroyProxy(pdf)` from the engine.
- **`getDocument` detaches the buffer it is given.** Always pass a copy (`bytes.slice()`), or use
  `engine.loadPdfjs(bytes)`, which copies for you.
- **Load documents with `engine.loadPdfjs` / `documentParams()`.** They use one shared `PDFWorker` and the
  asset URLs pdf.js needs (`cMapUrl`, `standardFontDataUrl`, `wasmUrl`, `iccUrl` under `/pdfjs/`). Those assets
  are copied by `scripts/copy-pdfjs-assets.mjs` (predev, prebuild, postinstall). Don't call `getDocument` with
  `GlobalWorkerOptions.workerPort`: destroying one document would kill the worker for every other one.
  `isEvalSupported` has been removed.
- **The pdf.js proxy is replaced on every byte change.** Each `commitBytes` creates a new `doc.pdf`. Only use
  `doc.pdf` when `doc.pdfVersion === doc.version`. Never keep a `PDFPageProxy` across versions; key caches by
  `doc.version` or by page id plus version.
- **Form values live in `doc.pdf.annotationStorage`** while the user is editing. Call
  `engine.commitFormValues(docId)` before reading the bytes yourself. `withLib`, the page operations and export
  do this for you.
- **In Node** (scripts and tests), use `import('pdfjs-dist/legacy/build/pdf.mjs')` with
  `standardFontDataUrl: '<repo>/node_modules/pdfjs-dist/standard_fonts/'` and `verbosity: 0`. A missing or wrong
  password rejects with `err.name === 'PasswordException'`. See `openPdfjs` / `inspectPdf` in `e2e/helpers.ts`.
- **pdf.js text-layer and annotation-layer CSS** depends on `--scale-factor`, `--total-scale-factor`,
  `--user-unit` and `--scale-round-x/y`. The viewer sets these on `.pdfwizard-page`. If you render your own layer
  elsewhere, you must set them too.

### @cantoo/pdf-lib gotchas

- **Always `import … from '@cantoo/pdf-lib'`.** The plain `pdf-lib` package isn't installed. In core types,
  `LibDocument` / `LibPage` are aliases for its `PDFDocument` / `PDFPage`.
- **Encryption:**
  - `PDFDocument.load(bytes, { password })` decrypts.
  - Without the password, loading throws; with `ignoreEncryption: true` it loads, but strings and streams stay
    encrypted, so don't edit that document.
  - The engine keeps `doc.bytes` decrypted and re-encrypts in the export hook at order 1000, from `doc.security`.
    Features never deal with encryption themselves.
- **In `pdfDoc.context.obj({...})`, JS strings become PDF names.** Use `PDFString.of(...)` or
  `PDFHexString.fromText(...)` for text values, including in `AnnotationSpec.extra`.
- **Edit bytes through `engine.withLib(docId, label, (lib, pages) => …)`.** It commits form values, loads,
  saves with garbage collection, and makes the change one undo step. If your edit changes the page count or
  order, return the new `PageInfo[]`, keeping existing ids for pages that survive. Otherwise the pages are
  re-read and ids are matched by index, and objects end up on the wrong pages.
- **Don't call `removePage` or `insertPage` directly** for user-facing page operations. Use the engine
  operations: they rebuild the page tree, remap page labels, drop dead link and outline destinations, and
  move objects with their pages.
- Documents are loaded with `updateMetadata: false`, so the Producer and ModDate aren't rewritten unless the
  metadata hook changes them.

### Viewer extension-point gotchas

- **What the viewer mounts:**
  - A tool's `PageOverlay` is mounted over **every visible page** (`position:absolute; inset:0`).
  - Pages away from the viewport are unmounted, so don't keep DOM references. Use
    `getPageElement(docId, i)`, which may return `null`, or `usePageViewport(docId, i)`.
- **Page DOM:**
  - Each page is `.pdfwizard-page[data-testid=page]` with `data-page-index`, `data-page-id` and `data-rotation`
    (the total rotation).
  - It gets `.is-painted` / `data-painted="true"` once the canvas is drawn.
  - Its layers, in order: canvas, `.textLayer`, `.annotationLayer`, decorations, `.pdfwizard-objects`, the tool overlay.
- **Hit testing:** with `hit: 'shape'` the object wrapper ignores pointer events, and your SVG has to opt in
  with `pointer-events: stroke/visiblePainted/auto`. With the default `hit: 'box'`, the whole box is clickable.
- **Text tools:** set `textSelection: true` on text-markup tools so the text layer stays selectable, then
  handle `onTextSelected`. Without it, the overlay covers the text.
- **Moving and resizing:** if `data` holds coordinates (ink points, line ends), implement `translate` and
  `resize`. The defaults only change `rect`.
- **Keyboard:** the viewer handles Delete/Backspace, the arrow keys and Cmd/Ctrl+C/X/V/D for the object
  selection. Plain-key tool shortcuts are ignored while an input, textarea or contentEditable has focus.
- **Programmatic scrolling:** use `actions.goToPage(docId, index, { point?, rect? })` or
  `scrollToObject(docId, objectId)`. Don't set `scrollTop` yourself.
- **Shortcut hints:** the menus show shortcut hints themselves. Pass `shortcut` in your
  `CommandDef` / `MenuItem`; don't write it into the label.

## Running and testing

```bash
npm run dev                                 # Vite :5173
scripts/dev-instance.sh <name> <web>        # isolated instance (own origin, so its own library; own Vite cache)
scripts/dev-instance.sh stop <name>
npm run fixtures                            # regenerate fixtures/ (see fixtures/README.md for their exact contents)

npx tsc -p tsconfig.json --noEmit           # client
npx tsc -p tsconfig.node.json --noEmit      # scripts + e2e
npx vite build                              # static dist/ (BASE_PATH=/repo/ for a sub-path, e.g. GitHub Pages)
npx tsx --tsconfig tsconfig.json scripts/sign-selftest.ts   # signing core + pdfsig
npx playwright test                         # e2e (chromium); starts its own Vite :5199
npx playwright test -g "thumbnails"         # a subset
```

- **Playwright config** (`playwright.config.ts`):
  - It never reuses a running server, so port 5199 must be free.
  - Every test gets a fresh browser context, so an empty library.
  - On failure, traces and screenshots go to `/tmp/pdfwizard-e2e-results/`. Open a trace with
    `npx playwright show-trace <trace.zip>`.
- **Helpers** (`e2e/helpers.ts`):
  - A `test` fixture that fails any test that logs `console.error` or throws `pageerror`.
  - Opening and waiting: `openFixture(page, name, { password? })`, `waitForDocReady`, `waitForPagesRendered`.
  - State: `getAppState` / `getDoc`, a summary of `window.__app` state.
  - Page operations: `engineOp(page, 'rotatePages', [1], 90)`, `expectNewVersion(page, op)`, `pageOrder`.
  - Library: `fetchLibraryBytes(page, id)`, `listLibrary(page)`, `uploadToLibrary(page, name, bytes)`.
  - Downloads and inspection: `captureDownload`, `inspectPdf` (pdf.js in Node),
    `needsPassword`, `loadLib` (pdf-lib).
- **Adding tests for a feature:** add `e2e/<feature>.spec.ts` that imports `{ test, expect }` from `./helpers`.
  Drive the UI through `data-testid`s. Check state through `getDoc` and verify the resulting file through
  `inspectPdf` / `loadLib`.
- **Menu entries:** the accessible names of menu entries include the shortcut ("Fit page ⌥⌘1"), and checkable
  entries use `role=menuitemcheckbox`. Match entries by text prefix, as `menuItem()` in `e2e/core.spec.ts` does.

/**
 * Core data model shared by every part of the app.
 *
 * COORDINATES: everything stored in the model is in PDF *user space* of the page:
 * points (1/72 in), origin at the bottom-left of the page's coordinate system, y pointing UP,
 * and *unrotated* (the page's /Rotate and the view rotation are applied only when displaying).
 * Coordinates are absolute user-space values (NOT relative to the CropBox origin), so they can
 * be written straight into annotation /Rect entries or used with pdf-lib drawing calls.
 * Use pdf.js `viewport.convertToViewportPoint` / `convertToPdfPoint` (or the helpers in
 * `core/geometry.ts`) to go between PDF space and on-screen CSS pixels.
 */
import type { ComponentType, ReactNode } from 'react';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { PDFDocument as LibDocument, PDFPage as LibPage, PDFFont, PDFRef, StandardFonts } from '@cantoo/pdf-lib';

export type DocId = string;
export type PageId = string;
export type ObjectId = string;
export type Rotation = 0 | 90 | 180 | 270;

export interface Point { x: number; y: number }
/** Axis-aligned rectangle in PDF user space; (x, y) is the bottom-left corner. */
export interface Rect { x: number; y: number; width: number; height: number }
/** Rectangle in CSS pixels relative to the top-left of a rendered page. */
export interface ViewBox { left: number; top: number; width: number; height: number }

export type IconType = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number; color?: string }>;

// ─────────────────────────────────────────────────────────────────────────────
// Pages & documents
// ─────────────────────────────────────────────────────────────────────────────

export interface PageInfo {
  /** Stable id for the page; survives reorder/rotate/insert operations. */
  id: PageId;
  /** Visible box (CropBox ∩ MediaBox) in user space: [x0, y0, x1, y1] (pdf.js `page.view`). */
  view: [number, number, number, number];
  /** Unrotated width/height in points (view[2]-view[0], view[3]-view[1]). */
  width: number;
  height: number;
  /** Intrinsic /Rotate of the page. */
  rotation: Rotation;
  /** Page label from the PDF (/PageLabels), if any. */
  label?: string;
}

export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string; // ISO
  modificationDate?: string; // ISO
  pdfVersion?: string;
  isEncrypted?: boolean;
  isLinearized?: boolean;
  hasForms?: boolean;
  hasXfa?: boolean;
  fileSize?: number;
}

export interface OutlineItem {
  id: string;
  title: string;
  /** Destination page (index into doc.pages at the time the outline was read / edited). */
  pageId: PageId | null;
  /** Optional y position (PDF user space) on the destination page. */
  top?: number | null;
  url?: string | null;
  bold?: boolean;
  italic?: boolean;
  color?: string | null;
  open?: boolean;
  children: OutlineItem[];
}

export interface SecuritySettings {
  /** Password required to open. Empty/undefined = none. */
  userPassword?: string;
  /** Permissions password. */
  ownerPassword?: string;
  permissions?: {
    printing?: false | 'lowResolution' | 'highResolution';
    modifying?: boolean;
    copying?: boolean;
    annotating?: boolean;
    fillingForms?: boolean;
    contentAccessibility?: boolean;
    documentAssembly?: boolean;
  };
}

export type FitMode = 'width' | 'page' | null;
export type PageLayout = 'continuous' | 'single' | 'two-page' | 'two-page-continuous';

export interface ScrollRequest {
  pageIndex: number;
  /** Optional PDF-space point to bring into view (top of view). */
  point?: Point;
  /** Optional rect to make visible (scrolled into view, centered if possible). */
  rect?: Rect;
  behavior?: 'auto' | 'smooth';
  nonce: number;
}

export interface ViewState {
  /** CSS pixels per PDF point (1 = 100%). */
  zoom: number;
  /** When set, the viewer recomputes zoom to fit on container resize. */
  fit: FitMode;
  layout: PageLayout;
  /** Extra rotation applied to the view only (not saved into the file). */
  rotation: Rotation;
  /** 0-based index of the page currently most visible. */
  currentPage: number;
  /** One-shot scroll request consumed by the viewer (compare nonce). */
  scrollRequest: ScrollRequest | null;
  /** Render page content inverted/dimmed for night reading. */
  darkPages?: boolean;
}

/** Transient visual highlights drawn by the viewer below overlay objects (search hits, diffs...). */
export interface Decoration {
  pageId: PageId;
  rects: Rect[];
  /** CSS color; default translucent yellow. */
  color?: string;
  /** Optional extra class name on each rect element. */
  className?: string;
  /** Marks the "current" decoration (e.g. active search hit) — drawn more prominently. */
  active?: boolean;
  title?: string;
}

export interface Snapshot {
  label: string;
  bytes: Uint8Array;
  version: number;
  pages: PageInfo[];
  objects: Record<ObjectId, PdfObject>;
  order: ObjectId[];
  meta: DocMeta;
  outline: OutlineItem[] | null;
  coalesce?: string;
  time: number;
}

export interface DocState {
  id: DocId;
  /** File name shown in tabs, e.g. "report.pdf". */
  name: string;
  /** Id of the file in the server library, if it came from / was saved to it. */
  fileId: string | null;
  /** Current base PDF bytes (unencrypted). Source of truth for page content. NEVER mutate in place. */
  bytes: Uint8Array;
  /** Bumps (globally unique, monotonic) every time `bytes` changes. */
  version: number;
  /** pdf.js document loaded from `bytes` of `pdfVersion`. May lag behind `version` briefly. */
  pdf: PDFDocumentProxy | null;
  pdfVersion: number;
  loading: boolean;
  loadError: string | null;
  pages: PageInfo[];
  /** Overlay objects (annotations, fill&sign items, added content...) not yet baked into `bytes`. */
  objects: Record<ObjectId, PdfObject>;
  /** Z-order of objects (later = on top). */
  order: ObjectId[];
  selection: ObjectId[];
  /** Object currently in inline-edit mode (e.g. typing into a text box). */
  editingId: ObjectId | null;
  history: { past: Snapshot[]; future: Snapshot[] };
  /** True when there are changes not yet saved/downloaded. */
  dirty: boolean;
  view: ViewState;
  meta: DocMeta;
  outline: OutlineItem[] | null;
  /** Encryption to apply when exporting; null = none. Pre-filled when the source file was encrypted. */
  security: SecuritySettings | null;
  /** Password the file was opened with (if encrypted). */
  openPassword: string | null;
  /** Keyed decoration sets (e.g. decorations['search']). */
  decorations: Record<string, Decoration[]>;
  /** Per-feature scratch state, keyed by feature id. Not part of undo history. */
  ext: Record<string, unknown>;
  openedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay objects
// ─────────────────────────────────────────────────────────────────────────────

export interface Reply { id: string; author: string; text: string; createdAt: number }
export type ReviewStatus = 'none' | 'accepted' | 'rejected' | 'cancelled' | 'completed';

/**
 * An editable object drawn over a page. Features define concrete kinds, e.g.
 *   type InkObject = PdfObject<'ink', { paths: Point[][] }>
 * `rect` is the bounding box and is what selection/move/resize operate on.
 */
export interface PdfObject<K extends string = string, D = any> {
  id: ObjectId;
  kind: K;
  pageId: PageId;
  rect: Rect;
  author: string;
  createdAt: number;
  modifiedAt: number;
  /** Primary (stroke/markup/text) color, '#rrggbb'. */
  color?: string;
  /** Interior fill color, '#rrggbb' or null for none. */
  fillColor?: string | null;
  /** 0..1 */
  opacity?: number;
  /** Border / stroke width in points. */
  strokeWidth?: number;
  /** Comment text attached to the object (note body, markup comment...). */
  contents?: string;
  replies?: Reply[];
  status?: ReviewStatus;
  locked?: boolean;
  /** Imported from an annotation that existed in the source PDF. */
  imported?: boolean;
  data: D;
}

export interface ObjectRenderProps<T extends PdfObject = PdfObject> {
  obj: T;
  docId: DocId;
  page: PageInfo;
  pageIndex: number;
  /** pdf.js viewport for the page at the current zoom & total rotation (CSS px). */
  viewport: PageViewport;
  /** CSS px per PDF point. */
  scale: number;
  /** Total rotation applied on screen: (page.rotation + view.rotation) % 360. */
  rotation: Rotation;
  /** obj.rect converted to CSS px relative to the page's top-left. The wrapper div is positioned here. */
  box: ViewBox;
  /** Map a PDF point to CSS px relative to `box`'s top-left (for drawing inside an <svg> filling the box). */
  toLocal(p: Point): { x: number; y: number };
  selected: boolean;
  /** True when inline editing is active for this object (after double-click / on creation). */
  editing: boolean;
  setEditing(editing: boolean): void;
  /** Convenience: update this object (pushes an undo checkpoint unless opts.checkpoint === false). */
  update(patch: Partial<T>, opts?: UpdateOptions): void;
}

export interface UpdateOptions {
  /** Push an undo checkpoint before applying (default true). */
  checkpoint?: boolean;
  /** Merge with the previous checkpoint if it has the same coalesce key and is < 1.5 s old. */
  coalesce?: string;
  label?: string;
}

export type ObjectCategory =
  | 'comment' // sticky notes, text markup, drawing/shape comments — listed in the Comments panel
  | 'fill-sign' // fill & sign text, marks, signatures
  | 'content' // added page content (text, images) from Edit PDF
  | 'link'
  | 'redaction'
  | 'form' // form fields being authored
  | 'measure'
  | 'other';

export interface ObjectTypeDef<T extends PdfObject = PdfObject> {
  kind: string;
  /** Human label, e.g. "Highlight". */
  label: string;
  icon?: IconType;
  category: ObjectCategory;
  /** Visual component. Rendered inside an absolutely-positioned wrapper at `box`. */
  Render: ComponentType<ObjectRenderProps<T>>;
  /**
   * 'box' (default): the whole bounding box is clickable.
   * 'shape': wrapper ignores pointer events; the Render component opts shapes in with `pointer-events: auto`
   *          (use for thin strokes / highlights so the gaps don't steal clicks).
   */
  hit?: 'box' | 'shape';
  movable?: boolean; // default true
  resizable?: boolean; // default true
  keepAspectRatio?: boolean;
  /** Minimum size in PDF points when resizing. */
  minSize?: { width: number; height: number };
  /** Apply a move by (dx, dy) PDF points. Default: shifts rect only. Implement if `data` holds coordinates. */
  translate?(obj: T, dx: number, dy: number): Partial<T>;
  /** Apply a resize to `rect`. Default: sets rect only. Implement if `data` holds coordinates. */
  resize?(obj: T, rect: Rect): Partial<T>;
  /** Editor shown in the floating properties toolbar when a single object of this kind is selected. */
  PropertiesBar?: ComponentType<{ obj: T; docId: DocId; update(patch: Partial<T>, opts?: UpdateOptions): void }>;
  /** Double click / Enter enters editing mode (Render receives editing=true). */
  editable?: boolean;
  /** Short text summary for lists (Comments panel), e.g. highlighted text. */
  summary?(obj: T): string;
  /** Extra context-menu entries for this object. */
  contextMenu?(obj: T, docId: DocId): MenuItem[];
  /**
   * Write the object into the PDF being exported. Use ctx.annots.add(...) for real annotations
   * (respects ctx.options.flatten automatically) or pdf-lib page drawing for page content.
   * If omitted, the object is not exported.
   */
  exportToPdf?(obj: T, ctx: ExportContext): void | Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / import pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /**
   * 'download' / 'save' → full fidelity; 'print' → flatten everything visible;
   * 'bake' → used internally when objects are permanently merged into the base bytes;
   * 'share' → same as save.
   */
  purpose: 'download' | 'save' | 'print' | 'bake' | 'share';
  /** Draw all annotations into page content instead of writing annotation dictionaries. */
  flatten?: boolean;
  /** Only export these objects (default: all). */
  objectIds?: ObjectId[];
  /** Skip the security (encryption) step even if doc.security is set. */
  skipSecurity?: boolean;
  /** Skip all overlay objects (export base bytes + forms only). */
  skipObjects?: boolean;
}

export interface AppearanceSpec {
  /** Content-stream operators drawn in PDF *user space* (same coordinates as obj.rect). */
  ops: string;
  /** Resources dictionary (e.g. { Font: { Helv: fontRef }, ExtGState: { GS0: gsRef } }) built with pdfDoc.context.obj(). */
  resources?: import('@cantoo/pdf-lib').PDFDict;
  /** Defaults to the object's rect (expanded by strokeWidth). */
  bbox?: Rect;
}

export interface AnnotationSpec {
  /** PDF annotation subtype without the slash, e.g. 'Highlight', 'Ink', 'Square', 'FreeText', 'Text', 'Link'. */
  subtype: string;
  /** Extra dictionary entries, as a JS object passed to pdfDoc.context.obj() (strings become names!
   *  use PDFString.of / PDFHexString.fromText for text values). */
  extra?: Record<string, unknown>;
  /** Normal appearance. Strongly recommended so all viewers render it identically. */
  appearance?: AppearanceSpec;
  /** Override the /Rect (defaults to obj.rect). */
  rect?: Rect;
  /** Don't copy obj.contents into /Contents. */
  noContents?: boolean;
}

export interface AnnotationWriter {
  /**
   * Adds an annotation for `obj` to `page` (or, when ctx.options.flatten is true, draws its
   * appearance into the page content instead). Fills common entries from `obj`: Rect, C (color),
   * IC (fillColor), CA (opacity), BS/Border (strokeWidth), T (author), Contents, M, CreationDate, NM (id),
   * F (print flag), and replies (as /IRT Text annotations) + /RC-free /Popup. Returns the ref (null when flattened).
   */
  add(page: LibPage, obj: PdfObject, spec: AnnotationSpec): PDFRef | null;
  /** Draw an appearance directly into page content (used for flattening and page-content objects). */
  drawAppearance(page: LibPage, appearance: AppearanceSpec, opacity?: number): void;
}

export interface ExportContext {
  pdfDoc: LibDocument;
  doc: DocState;
  options: ExportOptions;
  /** pdf-lib page for a page id. */
  page(pageId: PageId): LibPage;
  pageInfo(pageId: PageId): PageInfo;
  /** Cached embedded standard fonts. */
  standardFont(name: StandardFonts | `${StandardFonts}`): Promise<PDFFont>;
  /** Cached embedded custom font (TTF/OTF bytes via fontkit), keyed by `key`. */
  customFont(key: string, bytes: () => Promise<ArrayBuffer>): Promise<PDFFont>;
  annots: AnnotationWriter;
}

export interface ExportHook {
  id: string;
  /** Lower runs first. Object export happens at order 0; encryption at order 1000. */
  order: number;
  run(ctx: ExportContext): void | Promise<void>;
  /**
   * The hook changes nothing for a document whose pages, objects, meta, outline and security are
   * unchanged since it was opened. Only when every registered hook says so is such a document
   * exported byte-for-byte as the original file (keeps digital signatures and incremental updates).
   */
  noopWhenUnchanged?: boolean;
}

export interface ImportContext {
  docId: DocId;
  pdf: PDFDocumentProxy;
  pages: PageInfo[];
  /** Current base bytes; hooks may replace them (e.g. strip annotations they imported as objects). */
  bytes: Uint8Array;
  setBytes(bytes: Uint8Array): void;
  addObjects(objs: PdfObject[]): void;
}

export interface ImportHook {
  id: string;
  order: number;
  run(ctx: ImportContext): void | Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension points (see core/registry.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface PageOverlayProps {
  docId: DocId;
  page: PageInfo;
  pageIndex: number;
  viewport: PageViewport;
  scale: number;
  rotation: Rotation;
  /** Convert a pointer event (client coords) to a PDF point on this page. */
  toPdf(clientX: number, clientY: number): Point;
  /** Convert a PDF point to CSS px relative to this page's top-left. */
  toView(p: Point): { x: number; y: number };
  /** Convert a PDF rect to CSS px box relative to this page's top-left. */
  rectToView(r: Rect): ViewBox;
}

/**
 * Always-on page layer (unlike a tool's PageOverlay, it is mounted on every rendered page whatever
 * the active tool). The container ignores the pointer (`pointer-events: none`); children that need
 * it set `pointer-events: auto`. Render null when there is nothing to show. Examples: rulers' page
 * guides, accessibility reading-order boxes, form tab-order badges.
 */
export interface PageLayerDef {
  id: string;
  /** Stacking among page layers with the same placement (higher = on top). */
  order: number;
  /**
   * 'under-objects': above the page content and decorations, below overlay objects.
   * 'over-objects' (default): above objects and the active tool's overlay, below selection handles.
   */
  placement?: 'under-objects' | 'over-objects';
  Component: ComponentType<PageOverlayProps>;
}

/** Props of a ViewerOverlay: the viewer it is mounted in and geometry helpers. */
export interface ViewerOverlayProps {
  docId: DocId;
  /** The viewer's scrolling element (null until mounted). */
  scroller: HTMLElement | null;
  /** The page under a client point and that point in PDF space, or null over the gaps between pages. */
  pageAt(clientX: number, clientY: number): { pageIndex: number; point: Point } | null;
  /** Client rect of a page (from the layout, so it works for pages virtualized away), or null when it isn't laid out. */
  pageClientRect(pageIndex: number): DOMRect | null;
}

/**
 * Viewer-wide overlay mounted once per DocumentViewer, positioned over the whole viewer (not
 * scrolled with the pages): loupe, pan & zoom window, rulers, auto-scroll indicator… The container
 * ignores the pointer; children opt in with `pointer-events: auto`. Render null when inactive.
 */
export interface ViewerOverlayDef {
  id: string;
  order: number;
  Component: ComponentType<ViewerOverlayProps>;
}

/** Per-page text selection made in the text layer, converted to PDF space. */
export interface TextSelectionInfo {
  docId: DocId;
  pageId: PageId;
  pageIndex: number;
  text: string;
  /** One rect per line fragment, PDF user space. */
  rects: Rect[];
}

export type ToolGroup =
  | 'select' | 'comment' | 'markup' | 'draw' | 'shape' | 'fill-sign' | 'edit' | 'redact' | 'form' | 'measure' | 'view' | 'other';

export interface ToolDef {
  id: string;
  label: string;
  icon: IconType;
  group: ToolGroup;
  /** Single key or combo, e.g. 'h', 'shift+k'. Ignored while typing in inputs. */
  shortcut?: string;
  order?: number;
  /** If set, the tool appears in the left quick-tools rail (sorted by this). */
  quick?: number;
  /** CSS cursor over pages while active. */
  cursor?: string;
  /**
   * Rendered on top of every visible page while the tool is active. It covers the page
   * (position:absolute; inset:0) and receives pointer events. Create objects via `actions.addObject`.
   */
  PageOverlay?: ComponentType<PageOverlayProps>;
  /** Options (color, thickness, font...) shown in the tool options bar while active. */
  OptionsBar?: ComponentType;
  /** Keep the text layer selectable while active (text markup tools). */
  textSelection?: boolean;
  /** Called when the user finishes selecting text while this tool is active. */
  onTextSelected?(selections: TextSelectionInfo[]): void;
  /** Return to the select tool after one object is created (the tool calls actions.toolDone()). */
  oneShot?: boolean;
  onActivate?(): void;
  onDeactivate?(): void;
}

export type TaskCategory =
  | 'popular' | 'create' | 'edit' | 'comment' | 'organize' | 'sign' | 'protect' | 'convert' | 'scan' | 'review' | 'forms' | 'ai' | 'other';

/** An entry in "All tools" (e.g. "Organize pages", "Compress a PDF"). */
export interface TaskDef {
  id: string;
  label: string;
  description: string;
  icon: IconType;
  /** Accent color for the icon tile. */
  color?: string;
  category: TaskCategory;
  order?: number;
  keywords?: string[];
  /** Needs an open document. If none is open, the shell asks the user to pick one first. */
  requiresDocument: boolean;
  /** Left side panel content while the task is open (sub-tools, options, "Apply" buttons...). */
  Panel?: ComponentType;
  /** Replaces the viewer area while the task is open (e.g. Organize pages grid, Compare, Combine). */
  MainView?: ComponentType;
  /** Tool ids shown in the task's secondary toolbar (top of the viewer) while open. */
  toolbar?: string[];
  onOpen?(): void;
  onClose?(): void;
  /** Show on Home as a quick action (sorted by this). */
  featured?: number;
}

/** Right-rail side panel (Comments, Thumbnails, Bookmarks, Attachments, Layers...). */
export interface PanelDef {
  id: string;
  label: string;
  icon: IconType;
  order: number;
  Component: ComponentType<{ docId: DocId }>;
  /** Optional count badge. */
  badge?(doc: DocState): number | undefined;
}

export type MenuId = 'file' | 'edit' | 'view' | 'document' | 'comment' | 'tools' | 'help';

export interface CommandDef {
  id: string;
  label: string;
  icon?: IconType;
  /** e.g. 'mod+s', 'mod+shift+z', 'ctrl+alt+p'. 'mod' = Cmd on macOS, Ctrl elsewhere. */
  shortcut?: string;
  /** Show in this top-level menu (hamburger menu section). */
  menu?: MenuId;
  /** Grouping/sort within the menu. */
  group?: string;
  order?: number;
  /** Command needs an active document. */
  requiresDocument?: boolean;
  enabled?(): boolean;
  run(): void | Promise<void>;
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconType;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  run(): void | Promise<void>;
}

/** Popup action shown after the user selects text with the select tool (Highlight, Copy, Redact...). */
export interface TextSelectionAction {
  id: string;
  label: string;
  icon: IconType;
  order: number;
  run(selections: TextSelectionInfo[]): void | Promise<void>;
}

export interface ContextMenuContribution {
  id: string;
  /** Where it appears. */
  target: 'page' | 'object' | 'thumbnail';
  order?: number;
  items(ctx: { docId: DocId; pageIndex?: number; objectIds?: ObjectId[]; point?: Point }): MenuItem[];
}

/** Converts non-PDF files into PDF bytes when opened (e.g. images, Office docs via the server). */
export interface FileHandler {
  id: string;
  /** Lower-case extensions without dot, e.g. ['docx','xlsx']; or mime prefixes like 'image/'. */
  extensions: string[];
  mimePrefixes?: string[];
  label: string;
  convert(file: File): Promise<Uint8Array>;
}

/** Content for the "status" area on the document tab bar / home (optional). */
export interface HomeSection {
  id: string;
  order: number;
  Component: ComponentType;
}

/**
 * Feature-owned hash route `#/<prefix>/<arg>` (e.g. `#/sign/<token>` for e-sign recipients,
 * `#/review/<token>` for shared reviews). Core prefixes (tools, file, share, doc, task) can't be taken.
 */
export interface RouteHandler {
  /** First path segment, e.g. 'sign'. */
  prefix: string;
  /** Called when the URL shows this route (initial load, link click, back/forward). Open documents, tasks… */
  open(arg: string): void | Promise<void>;
  /**
   * Hash that represents `doc` while it is the active document (e.g. `#/sign/<token>` when
   * doc.ext holds a signing token), or null to fall back to the core `#/file/…` / `#/doc/…` hash.
   */
  docHash?(doc: DocState): string | null;
}

// Re-export for convenience
export type { PDFDocumentProxy, PageViewport, LibDocument, LibPage, ReactNode };

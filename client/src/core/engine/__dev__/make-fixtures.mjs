// Extra engine fixtures (written to /tmp/engine-fixtures): node client/src/core/engine/__dev__/make-fixtures.mjs
import { PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts, rgb } from '@cantoo/pdf-lib';
import fs from 'node:fs';

const OUT = '/tmp/engine-fixtures';
fs.mkdirSync(OUT, { recursive: true });

/** Page tree with inherited MediaBox / Rotate / Resources in intermediate nodes, a shared indirect Contents array and page labels. */
async function inherited() {
  const d = await PDFDocument.create({ updateMetadata: false });
  const ctx = d.context;
  const font = await d.embedFont(StandardFonts.Helvetica);
  await d.flush();
  const fontRef = font.ref;
  const res = ctx.register(ctx.obj({ Font: { F1: fontRef } }));
  const shared = ctx.register(ctx.flateStream('0 0 1 rg 20 20 60 60 re f'));
  const rootRef = d.catalog.get(PDFName.of('Pages'));
  const mid = ctx.nextRef();
  const kids = [];
  for (let i = 0; i < 4; i++) {
    const own = ctx.register(ctx.flateStream(`BT /F1 36 Tf 100 400 Td (Inherited ${i + 1}) Tj ET`));
    const contents = ctx.register(ctx.obj([shared, own]));
    const leafRef = ctx.register(ctx.obj({ Type: 'Page', Parent: mid, Contents: contents }));
    kids.push(leafRef);
  }
  ctx.assign(mid, ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: kids, Count: 4, MediaBox: [0, 0, 500, 600], Rotate: 90, Resources: res }));
  const root = ctx.lookup(rootRef);
  root.set(PDFName.of('Kids'), ctx.obj([mid]));
  root.set(PDFName.of('Count'), ctx.obj(4));
  d.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D', St: 1, P: PDFString.of('A-') }] }));
  fs.writeFileSync(`${OUT}/inherited.pdf`, await d.save({ useObjectStreams: false, addDefaultPage: false }));
}

/** Fields whose widget is merged into the field dictionary (no Kids). */
async function mergedForm() {
  const d = await PDFDocument.create({ updateMetadata: false });
  const ctx = d.context;
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([612, 792]);
  page.drawText('Merged fields', { x: 72, y: 720, size: 20, font });
  await d.flush();
  const helv = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const ap = ctx.register(ctx.stream('/Tx BMC q BT /Helv 12 Tf 2 6 Td (hello) Tj ET Q EMC', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 24], Resources: { Font: { Helv: helv } } }));
  const text = ctx.register(
    ctx.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('merged_text'), V: PDFString.of('hello'),
      Rect: [72, 600, 272, 624], P: page.ref, F: 4, DA: PDFString.of('/Helv 12 Tf 0 g'), AP: { N: ap },
    }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([text]));
  d.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [text], DA: PDFString.of('/Helv 0 Tf 0 g'), DR: { Font: { Helv: helv } } }));
  fs.writeFileSync(`${OUT}/merged-form.pdf`, await d.save({ useObjectStreams: false }));
}

/** PDF/A-1b identification in XMP (encryption must strip it). */
async function pdfa() {
  const d = await PDFDocument.create({ updateMetadata: false });
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([400, 300]).drawText('PDF/A document', { x: 40, y: 150, size: 24, font, color: rgb(0.1, 0.3, 0.6) });
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Archive</rdf:li></rdf:Alt></dc:title></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const s = d.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  d.catalog.set(PDFName.of('Metadata'), d.context.register(s));
  d.setTitle('Archive');
  fs.writeFileSync(`${OUT}/pdfa.pdf`, await d.save());
}

/** A two-page PDF used as insert / replace source, with a comment and a link on page 1. */
async function source() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < 2; i++) {
    const p = d.addPage([420, 595]);
    p.drawRectangle({ x: 0, y: 0, width: 420, height: 595, color: rgb(0.9, 0.97, 0.9) });
    p.drawText(`Source page ${i + 1}`, { x: 40, y: 500, size: 30, font, color: rgb(0, 0.4, 0) });
  }
  const p0 = d.getPage(0);
  const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 520, 320, 540], Contents: PDFHexString.fromText('Source note'), T: PDFString.of('Src'), P: p0.ref }));
  const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 490, 300, 530], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.org/') } }));
  p0.node.set(PDFName.of('Annots'), d.context.obj([note, link]));
  d.setTitle('Source');
  fs.writeFileSync(`${OUT}/source.pdf`, await d.save());
}

/** Other security handlers: AES-128 and RC4-128 with a user password, and owner-only restrictions (no open password). */
async function ciphers() {
  for (const [file, options] of [
    ['aes128.pdf', { userPassword: 'pw', ownerPassword: 'own', algorithm: 'AES-128' }],
    ['rc4.pdf', { userPassword: 'pw', ownerPassword: 'own', algorithm: 'RC4-128', allowWeakCryptography: true }],
    ['restricted.pdf', { ownerPassword: 'own', permissions: { printing: false, copying: false, modifying: false } }],
  ]) {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) d.addPage([500, 400]).drawText(`${file} page ${i + 1}`, { x: 40, y: 200, size: 28, font });
    d.setTitle(`Cipher ${file}`);
    d.encrypt(options);
    fs.writeFileSync(`${OUT}/${file}`, await d.save());
  }
}

await ciphers();
await inherited();
await mergedForm();
await pdfa();
await source();
console.log('fixtures written to', OUT, fs.readdirSync(OUT));

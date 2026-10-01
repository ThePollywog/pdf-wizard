/**
 * Self-test of the browser signing core (features/digital-sign) in Node:
 *   npx tsx scripts/sign-selftest.ts [out-dir]
 * Signs fixtures with a throwaway test identity (twice, as a second signer would), then checks the
 * result with our verifier and, when poppler's `pdfsig` is installed, with it too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestIdentity } from '../client/src/features/digital-sign/bridge';
import { assembleSignedData, buildSignedAttributes, verifyCms } from '../client/src/features/digital-sign/cms';
import { listSignatureFields, prepareSignature, readSignatures, type SignTarget } from '../client/src/features/digital-sign/pdf';

const out = process.argv[2] ?? fs.mkdtempSync('/tmp/pdfwizard-sign-');
fs.mkdirSync(out, { recursive: true });

async function rsaSign(jwk: JsonWebKey, digest: Uint8Array): Promise<Uint8Array> {
  // Same math as the dev test signer; imported lazily to keep bridge.ts browser-first.
  const mod = await import('../client/src/features/digital-sign/bridge');
  return (mod as unknown as { __rsaSignDigest: (j: JsonWebKey, d: Uint8Array) => Promise<Uint8Array> }).__rsaSignDigest(jwk, digest);
}

async function sign(bytes: Uint8Array, target: SignTarget, cn: string): Promise<Uint8Array> {
  const id = await makeTestIdentity(cn);
  const prepared = await prepareSignature(bytes, target, { heading: 'Digitally signed by', name: cn, lines: ['Date: 2026.09.29 10:00:00 -04\'00\''] }, {
    signerName: cn, date: new Date(), subFilter: 'ETSI.CAdES.detached', reason: 'I approve this document',
  });
  const req = await buildSignedAttributes(prepared.signedData(), id.der);
  const cms = assembleSignedData(req, await rsaSign(id.jwk, req.digest));
  const v = await verifyCms(cms, prepared.signedData());
  if (!v.intact) throw new Error('self-verification failed');
  return prepared.finish(cms);
}

let failed = false;
for (const fixture of ['form.pdf', 'sample.pdf', 'large.pdf']) {
  const src = new Uint8Array(fs.readFileSync(path.join('fixtures', fixture)));
  // Sign the form's own empty signature field when it has one, else a new field.
  const empty = (await listSignatureFields(src)).find((f) => !f.signed);
  let bytes = await sign(src, empty ? { kind: 'field', fieldRef: empty.fieldRef } : { kind: 'new', pageIndex: 0, rect: { x: 72, y: 72, width: 200, height: 50 } }, 'DOE.JANE.Q.1234567890');
  bytes = await sign(bytes, { kind: 'new', pageIndex: 0, rect: { x: 330, y: 40, width: 200, height: 50 } }, 'ROE.RICHARD.A.9876543210');
  const file = path.join(out, `signed-${fixture}`);
  fs.writeFileSync(file, bytes);
  const fields = await listSignatureFields(bytes);
  const sigs = await readSignatures(bytes);
  console.log(`${fixture}: ${fields.length} signature fields, ${sigs.length} signed, prefix kept: ${Buffer.from(bytes.subarray(0, src.length)).equals(Buffer.from(src))}`);
  try {
    const r = execFileSync('pdfsig', [file], { encoding: 'utf8' });
    const ok = (r.match(/Signature Validation: Signature is Valid\./g) ?? []).length;
    console.log(`  pdfsig: ${ok}/2 valid`);
    if (ok !== 2) {
      failed = true;
      console.log(r);
    }
  } catch (e) {
    const err = e as { code?: string; stdout?: string };
    if (err.code === 'ENOENT') console.log('  pdfsig not installed');
    else {
      failed = true;
      console.log(err.stdout ?? e);
    }
  }
}
console.log(`output: ${out}`);
process.exit(failed ? 1 : 0);

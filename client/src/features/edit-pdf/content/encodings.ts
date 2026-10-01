/**
 * Simple-font encodings (codes 32…255, "." = undefined) and glyph-name → Unicode lookup for the
 * glyph names used by those encodings (plus uniXXXX / uXXXX names and single characters).
 */
const TABLES = {
  Standard: `space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl . endash dagger daggerdbl periodcentered . paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand . questiondown . grave acute circumflex tilde macron breve dotaccent dieresis . ring cedilla . hungarumlaut ogonek caron emdash . . . . . . . . . . . . . . . . AE . ordfeminine . . . . Lslash Oslash OE ordmasculine . . . . . ae . . . dotlessi . . lslash oslash oe germandbls . . . .`,
  MacRoman: `space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde . Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron`,
  WinAnsi: `space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde bullet Euro bullet quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE bullet Zcaron bullet bullet quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe bullet zcaron Ydieresis space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis`,
};

export type EncodingName = keyof typeof TABLES;

const cache = new Map<EncodingName, string[]>();

/** 256-entry glyph-name table of a base encoding ('' = undefined code). */
export function encodingTable(name: EncodingName): string[] {
  let t = cache.get(name);
  if (!t) {
    t = new Array<string>(32).fill('').concat(TABLES[name].split(' ').map((n) => (n === '.' ? '' : n)));
    while (t.length < 256) t.push('');
    cache.set(name, t);
  }
  return t;
}

const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const EXTRA: Record<string, number> = {
  Lslash: 0x141, lslash: 0x142, fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, dotlessi: 0x131,
  fraction: 0x2044, breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, hungarumlaut: 0x2dd, ogonek: 0x2db,
  caron: 0x2c7, notequal: 0x2260, infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265,
  partialdiff: 0x2202, summation: 0x2211, product: 0x220f, pi: 0x3c0, integral: 0x222b, Omega: 0x2126,
  radical: 0x221a, approxequal: 0x2248, Delta: 0x2206, lozenge: 0x25ca, minus: 0x2212, apple: 0xf8ff,
  nbspace: 0xa0, sfthyphen: 0xad, hyphentwo: 0x2010, figuredash: 0x2012, quotereversed: 0x201b,
  arrowright: 0x2192, arrowleft: 0x2190, arrowup: 0x2191, arrowdown: 0x2193, checkmark: 0x2713,
  Euro: 0x20ac, onesuperior: 0xb9, twosuperior: 0xb2, threesuperior: 0xb3,
};

let nameMap: Map<string, number> | null = null;

function buildNameMap(): Map<string, number> {
  const m = new Map<string, number>();
  const win = encodingTable('WinAnsi');
  for (let c = 32; c < 256; c++) {
    const n = win[c];
    if (!n || m.has(n)) continue;
    m.set(n, c >= 0x80 && c < 0xa0 ? CP1252[c] ?? 0x2022 : c);
  }
  for (const [n, cp] of Object.entries(EXTRA)) if (!m.has(n)) m.set(n, cp);
  return m;
}

/** Unicode text of a glyph name ('' when unknown). */
export function glyphToUnicode(name: string): string {
  if (!name) return '';
  nameMap ??= buildNameMap();
  const base = name.split('.')[0];
  const hit = nameMap.get(base);
  if (hit !== undefined) return String.fromCodePoint(hit);
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(base);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  if (base.length === 1) return base;
  m = /^(?:g|glyph|cid|c)(\d+)$/.exec(base);
  if (m) return '';
  return '';
}

/** Glyph name for a Unicode code point in WinAnsi (undefined when not encodable). */
export function winAnsiCodeFor(cp: number): number | undefined {
  if (cp >= 32 && cp < 127) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  for (const [code, u] of Object.entries(CP1252)) if (u === cp) return Number(code);
  if (cp === 0x2022) return 0x95;
  return undefined;
}

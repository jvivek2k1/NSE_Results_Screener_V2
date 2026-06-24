// ============================================================
// PDF text extraction for NSE results attachments.
//
// NSE filings include a link to the full results document
// (attachment_filename). This is usually a .zip archive containing one
// or more PDFs (occasionally a direct PDF). We download it, extract the
// PDF text, and hand a trimmed version to the AI engine so GPT can reason
// over segment detail, management commentary and guidance — not just the
// headline numbers.
// ============================================================
import axios from 'axios';
import AdmZip from 'adm-zip';

// pdf-parse v2 exposes a PDFParse class: new PDFParse({ data }).getText().
let PDFParse = null;
async function getParser() {
  if (!PDFParse) {
    const mod = await import('pdf-parse');
    PDFParse = mod.PDFParse || mod.default?.PDFParse;
  }
  return PDFParse;
}

async function pdfToText(buffer) {
  const Parser = await getParser();
  const parser = new Parser({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result?.text || '';
  } finally {
    await parser.destroy?.();
  }
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/pdf,*/*',
  Referer: 'https://www.nseindia.com/',
};

// url -> extracted text (or null). Caches misses too, so we never retry a
// broken/oversized attachment within a process lifetime.
const cache = new Map();

function normalizeUrl(attachment) {
  if (!attachment || typeof attachment !== 'string') return null;
  let u = attachment.trim();
  if (!u) return null;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https://nsearchives.nseindia.com${u}`;
  return `https://nsearchives.nseindia.com/${u}`;
}

// Collapse whitespace and cap the text so we keep the prompt within a sane
// token budget (PDFs can be hundreds of pages of boilerplate).
function clean(text, maxChars) {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

export async function extractPdfText(attachment, { maxChars = 12000, timeoutMs = 20000 } = {}) {
  const url = normalizeUrl(attachment);
  if (!url || !/\.(pdf|zip)(\?|$)/i.test(url)) return null;
  if (cache.has(url)) return cache.get(url);

  let text = null;
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      timeout: timeoutMs,
      responseType: 'arraybuffer',
      maxContentLength: 25 * 1024 * 1024, // 25 MB ceiling
    });
    const buf = Buffer.from(res.data);

    let raw = '';
    if (/\.zip(\?|$)/i.test(url)) {
      // NSE bundles the results PDF(s) inside a zip; concatenate every PDF.
      const entries = new AdmZip(buf)
        .getEntries()
        .filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName));
      for (const entry of entries) {
        if (raw.length >= maxChars) break;
        try {
          raw += `\n${await pdfToText(entry.getData())}`;
        } catch (e) {
          console.warn(`[pdf] failed to parse ${entry.entryName}: ${e.message}`);
        }
      }
    } else {
      raw = await pdfToText(buf);
    }

    raw = raw.trim();
    if (raw) text = clean(raw, maxChars);
  } catch (err) {
    console.warn(`[pdf] could not read attachment (${url}): ${err.message}`);
    text = null;
  }
  cache.set(url, text);
  return text;
}

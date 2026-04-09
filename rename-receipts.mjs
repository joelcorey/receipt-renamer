#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pdf from 'pdf-parse';
import * as chrono from 'chrono-node';
import { createWorker } from 'tesseract.js';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pLimit from 'p-limit';

const args = process.argv.slice(2);

const options = {
  src: getArgValue(args, '--src'),
  dest: getArgValue(args, '--dest'),
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose'),
  move: args.includes('--move'),
  preserveStructure: args.includes('--preserve-structure'),
  concurrency: clampInt(getArgValue(args, '--concurrency') || '2', 1, Math.max(1, Math.min(os.cpus().length, 8))),
  maxOcrPages: clampInt(getArgValue(args, '--max-ocr-pages') || '2', 1, 5),
  logFile: getArgValue(args, '--log-file'),
  errorFile: getArgValue(args, '--error-file'),
  vendorConfigPath: getArgValue(args, '--vendor-config') || 'vendors.json',
};

if (!options.src || !options.dest) {
  console.error(
    [
      'Usage:',
      '  pnpm start -- --src "/path/to/source" --dest "/path/to/dest" [options]',
      '',
      'Options:',
      '  --dry-run               Show what would happen without copying or moving files',
      '  --move                  Move instead of copy',
      '  --verbose               Include more console detail',
      '  --preserve-structure    Recreate source subfolders inside destination',
      '  --concurrency N         Number of PDFs to process at once (default: 2)',
      '  --max-ocr-pages N       OCR page limit per PDF when fallback is needed (default: 2)',
      '  --vendor-config PATH    Vendor whitelist JSON file path (default: ./vendors.json)',
      '  --log-file PATH         JSONL operation log path',
      '  --error-file PATH       JSONL error log path',
    ].join('\n')
  );
  process.exit(1);
}

const sourceDir = path.resolve(options.src);
const destinationDir = path.resolve(options.dest);
const logFile = path.resolve(options.logFile || path.join(destinationDir, 'receipt-renamer.log.jsonl'));
const errorFile = path.resolve(options.errorFile || path.join(destinationDir, 'receipt-renamer.errors.jsonl'));
const vendorConfigPath = path.resolve(options.vendorConfigPath);

const GENERIC_VENDOR_WORDS = new Set([
  'receipt', 'invoice', 'statement', 'customer', 'merchant', 'transaction', 'approval',
  'purchase', 'debit', 'credit', 'card', 'sale', 'total', 'subtotal', 'amount',
  'auth', 'terminal', 'cashier', 'page', 'visa', 'mastercard', 'amex', 'discover',
  'thank', 'you', 'server', 'table', 'check', 'order', 'tip', 'store', 'location',
  'lane', 'register', 'change', 'cash', 'balance', 'account', 'item', 'qty',
  'quantity', 'price', 'tax', 'date', 'time', 'phone', 'tel', 'fax', 'website',
  'www', 'http', 'payment', 'method', 'entry', 'exit', 'invoice', 'inv'
]);

const GENERIC_LINE_PATTERNS = [
  /^https?:\/\//i,
  /^www\./i,
  /^(tel|phone|fax)[:\s]/i,
  /^store\s?#?\d*/i,
  /^invoice\s?#?/i,
  /^receipt\s?#?/i,
  /^transaction/i,
  /^card\s/i,
  /^(approval|auth|reference|trace|batch|terminal)\b/i,
  /^merchant\s?id/i,
  /^(date|time|subtotal|tax|total|amount|change|cash)\b/i,
  /^visa$/i,
  /^mastercard$/i,
  /^american express$/i,
  /^discover$/i,
  /^[#*=_~\-\s]+$/,
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.mkdir(path.dirname(errorFile), { recursive: true });

  const vendorConfig = await loadVendorConfig(vendorConfigPath);
  const pdfFiles = await walkForPdfs(sourceDir);

  if (pdfFiles.length === 0) {
    console.log(`No PDF files found in: ${sourceDir}`);
    return;
  }

  const limit = pLimit(options.concurrency);
  const worker = await createWorker('eng');

  const stats = {
    total: pdfFiles.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    ocrUsed: 0,
    copied: 0,
    moved: 0,
    skipped: 0,
  };

  try {
    const tasks = pdfFiles.map((filePath) => limit(() => processOnePdf(filePath, worker, stats, vendorConfig)));
    await Promise.all(tasks);
  } finally {
    await worker.terminate();
  }

  console.log('');
  console.log('Summary');
  console.log(`  total:      ${stats.total}`);
  console.log(`  processed:  ${stats.processed}`);
  console.log(`  succeeded:  ${stats.succeeded}`);
  console.log(`  failed:     ${stats.failed}`);
  console.log(`  ocr used:   ${stats.ocrUsed}`);
  console.log(`  copied:     ${stats.copied}`);
  console.log(`  moved:      ${stats.moved}`);
  console.log(`  skipped:    ${stats.skipped}`);
  console.log(`  log file:   ${logFile}`);
  console.log(`  error file: ${errorFile}`);
  console.log(`  vendors:    ${vendorConfigPath}`);
}

async function processOnePdf(filePath, worker, stats, vendorConfig) {
  const startedAt = new Date().toISOString();

  try {
    const buffer = await fs.readFile(filePath);
    const textSources = await getTextSources(buffer, worker, options.maxOcrPages);
    if (textSources.ocrUsed) stats.ocrUsed += 1;

    const combinedText = normalizeText(
      [textSources.pdfText, textSources.ocrText].filter(Boolean).join('\n')
    );

    const lines = splitLines(combinedText);
    const info = extractReceiptInfo(combinedText, lines, vendorConfig);
    const fileName = buildFileName(info);

    const relativeDir = path.relative(sourceDir, path.dirname(filePath));
    const destinationSubdir = options.preserveStructure
      ? path.join(destinationDir, relativeDir)
      : destinationDir;

    await fs.mkdir(destinationSubdir, { recursive: true });

    const destPath = await uniquePath(path.join(destinationSubdir, fileName));

    const entry = {
      level: 'info',
      event: options.dryRun ? 'dry-run' : options.move ? 'move' : 'copy',
      startedAt,
      finishedAt: new Date().toISOString(),
      source: filePath,
      destination: destPath,
      ocrUsed: textSources.ocrUsed,
      extracted: info,
      chars: {
        pdfText: textSources.pdfText.length,
        ocrText: textSources.ocrText.length,
        combined: combinedText.length,
      },
    };

    if (options.verbose) {
      console.log(`${options.dryRun ? 'DRY ' : options.move ? 'MOVE' : 'COPY'} ${filePath} -> ${destPath}`);
      console.log(`  ocrUsed=${textSources.ocrUsed} vendor=${info.vendor} vendorSource=${info.vendorSource} date=${info.date} dateSource=${info.dateSource} timeIn=${info.timeIn} timeOut=${info.timeOut}`);
    } else {
      console.log(`${options.dryRun ? 'DRY ' : options.move ? 'MOVE' : 'COPY'} ${path.basename(filePath)} -> ${path.basename(destPath)}`);
    }

    if (!options.dryRun) {
      if (options.move) {
        await moveFile(filePath, destPath);
        stats.moved += 1;
      } else {
        await fs.copyFile(filePath, destPath);
        stats.copied += 1;
      }
    } else {
      stats.skipped += 1;
    }

    stats.processed += 1;
    stats.succeeded += 1;
    await appendJsonLine(logFile, entry);
  } catch (error) {
    stats.processed += 1;
    stats.failed += 1;

    const errorEntry = {
      level: 'error',
      event: 'process-failed',
      source: filePath,
      at: new Date().toISOString(),
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || null,
    };

    console.error(`FAIL ${filePath}`);
    console.error(`     ${errorEntry.message}`);
    await appendJsonLine(errorFile, errorEntry);
  }
}

async function loadVendorConfig(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed.vendors)) {
      throw new Error('vendors.json must contain a top-level "vendors" array');
    }

    const vendors = parsed.vendors
      .map((item) => normalizeVendorConfigItem(item))
      .filter(Boolean);

    return { vendors };
  } catch (error) {
    throw new Error(`Could not load vendor config "${filePath}": ${error.message}`);
  }
}

function normalizeVendorConfigItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.name !== 'string' || !item.name.trim()) return null;

  const aliases = Array.isArray(item.aliases) ? item.aliases.filter((x) => typeof x === 'string' && x.trim()) : [];
  const output = typeof item.output === 'string' && item.output.trim()
    ? slugifyVendor(item.output)
    : slugifyVendor(item.name);

  return {
    name: item.name.trim(),
    output,
    aliases: [item.name.trim(), ...aliases].map((x) => x.trim()).filter(Boolean),
  };
}

async function walkForPdfs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkForPdfs(full));
    } else if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
      files.push(full);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function getTextSources(buffer, worker, maxOcrPages) {
  let pdfText = '';
  let ocrText = '';
  let ocrUsed = false;

  try {
    const parsed = await pdf(buffer);
    pdfText = normalizeText(parsed.text || '');
  } catch {
    pdfText = '';
  }

  if (needsOcrFallback(pdfText)) {
    ocrUsed = true;
    ocrText = await ocrPdfWithPdfJs(buffer, worker, maxOcrPages);
  }

  return { pdfText, ocrText, ocrUsed };
}

function needsOcrFallback(text) {
  if (!text) return true;

  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 80) return true;
  if ((clean.match(/[A-Za-z]/g) || []).length < 30) return true;
  if (splitLines(text).length < 3) return true;

  return false;
}

async function ocrPdfWithPdfJs(buffer, worker, maxPages = 2) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: undefined,
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = Math.min(pdfDoc.numPages, maxPages);
  const texts = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.25 });

    const canvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height))
    );
    const context = canvas.getContext('2d');

    await page.render({ canvasContext: context, viewport }).promise;

    const imageBuffer = canvas.toBuffer('image/png');
    const result = await worker.recognize(imageBuffer);
    const text = normalizeText(result?.data?.text || '');

    if (text) texts.push(text);
  }

  return texts.join('\n');
}

function extractReceiptInfo(text, lines, vendorConfig) {
  const dateResult = extractDate(text, lines);
  const vendorResult = extractVendor(text, lines, vendorConfig);
  const timeResult = extractTimes(text, lines);
  const isVisa = /\bvisa\b/i.test(text);

  return {
    date: dateResult.value || 'unknown-date',
    dateSource: dateResult.source || 'unknown',
    vendor: vendorResult.value || 'unknown-vendor',
    vendorSource: vendorResult.source || 'guess',
    timeIn: timeResult.timeIn || 'unknown-time-in',
    timeOut: timeResult.timeOut || 'unknown-time-out',
    isVisa,
  };
}

function extractDate(text, lines) {
  const firstDateAnywhere = findFirstDateByScan(text);
  if (firstDateAnywhere) {
    return { value: firstDateAnywhere, source: 'first-date-match' };
  }

  const labeledPatterns = [
    /\b(inv(?:oice)?\s*date)\b/i,
    /\b(invoice\s*date)\b/i,
    /\b(date)\b/i,
    /\b(transaction\s*date)\b/i,
    /\b(purchase\s*date)\b/i,
    /\b(posted\s*date)\b/i,
    /\b(sale\s*date)\b/i,
  ];

  for (const line of lines.slice(0, 50)) {
    for (const pattern of labeledPatterns) {
      if (pattern.test(line)) {
        const parsed = parseBestDate(line);
        if (parsed) {
          return { value: parsed, source: `label:${pattern.source}` };
        }
      }
    }
  }

  return { value: null, source: 'unknown' };
}

function findFirstDateByScan(text) {
  const patterns = [
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g,
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g,
    /\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2},?\s+\d{2,4}\b/gi,
  ];

  let earliest = null;

  for (const regex of patterns) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (!match) continue;

    if (!earliest || match.index < earliest.index) {
      earliest = { value: match[0], index: match.index };
    }
  }

  if (!earliest) return null;
  return parseBestDate(earliest.value);
}

function parseBestDate(input) {
  if (!input || !input.trim()) return null;

  const results = chrono.parse(input, new Date(), { forwardDate: false });
  for (const result of results) {
    const year = result.start.get('year');
    if (!year || year < 2000 || year > 2100) continue;
    return formatDate(result.start.date());
  }

  return null;
}

function extractVendor(text, lines, vendorConfig) {
  const whitelistMatch = findVendorWhitelistMatch(text, lines, vendorConfig);
  if (whitelistMatch) return whitelistMatch;

  const guessed = guessVendor(lines);
  return { value: guessed || 'unknown-vendor', source: 'guess' };
}

function findVendorWhitelistMatch(text, lines, vendorConfig) {
  const haystacks = [
    { value: text.toLowerCase(), weight: 3 },
    { value: lines.slice(0, 20).join('\n').toLowerCase(), weight: 2 },
  ];

  let best = null;

  for (const vendor of vendorConfig.vendors) {
    for (const alias of vendor.aliases) {
      const aliasLower = alias.toLowerCase();

      for (const haystack of haystacks) {
        const index = haystack.value.indexOf(aliasLower);
        if (index === -1) continue;

        const score = (1000 - Math.min(index, 1000)) + (haystack.weight * 100);
        if (!best || score > best.score) {
          best = {
            value: vendor.output,
            source: `whitelist:${alias}`,
            score,
          };
        }
      }
    }
  }

  return best ? { value: best.value, source: best.source } : null;
}

function guessVendor(lines) {
  const top = lines.slice(0, 25);
  const candidates = [];

  for (let index = 0; index < top.length; index += 1) {
    const line = cleanVendorLine(top[index]);
    if (!line) continue;

    const score = scoreVendorLine(line, index);
    if (score <= 0) continue;

    candidates.push({ line, score, index });
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  if (candidates.length === 0) return 'unknown-vendor';
  return slugifyVendor(candidates[0].line);
}

function cleanVendorLine(line) {
  if (!line) return '';
  return line
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, ' ')
    .trim();
}

function scoreVendorLine(line, index) {
  const clean = line.trim();
  if (!clean) return 0;
  if (clean.length < 2 || clean.length > 64) return 0;
  if (GENERIC_LINE_PATTERNS.some((pattern) => pattern.test(clean))) return 0;
  if (/^\d+$/.test(clean)) return 0;
  if (/\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|hwy|highway|suite)\b/i.test(clean)) return 0;
  if (/\b(?:cashier|server|register|operator|transaction|invoice|receipt|auth|approval|merchant id)\b/i.test(clean)) return 0;
  if (/\d{4,}/.test(clean)) return 0;

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 6) return 0;

  let score = 0;
  if (index === 0) score += 24;
  if (index === 1) score += 18;
  if (index < 5) score += 10;
  if (/^[A-Z0-9&.'\- ]+$/.test(clean)) score += 18;
  if (/[A-Za-z]/.test(clean)) score += 16;
  if (!/[#:]/.test(clean)) score += 8;
  if (words.length >= 1 && words.length <= 4) score += 12;

  const meaningfulWords = words.filter((w) => !GENERIC_VENDOR_WORDS.has(w.toLowerCase()));
  score += meaningfulWords.length * 5;

  if (meaningfulWords.length === 0) score = 0;
  if (/^[A-Z][A-Z0-9&.'\- ]+$/.test(clean)) score += 8;

  return score;
}

function extractTimes(text, lines) {
  const lineResults = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const tokens = extractTimeTokens(line);
    if (tokens.length === 0) continue;

    if (/\b(time[- ]?in|clock[- ]?in|check[- ]?in|in\s*time|arrival|start)\b/i.test(lower)) {
      lineResults.push({ type: 'in', value: tokens[0] });
    }
    if (/\b(time[- ]?out|clock[- ]?out|check[- ]?out|out\s*time|departure|end)\b/i.test(lower)) {
      lineResults.push({ type: 'out', value: tokens[tokens.length - 1] });
    }
  }

  const labeledIn = lineResults.find((x) => x.type === 'in')?.value || null;
  const labeledOut = [...lineResults].reverse().find((x) => x.type === 'out')?.value || null;

  if (labeledIn || labeledOut) {
    return {
      timeIn: labeledIn || 'unknown-time-in',
      timeOut: labeledOut || 'unknown-time-out',
    };
  }

  const allTimes = extractTimeTokens(text);
  if (allTimes.length >= 2) {
    const sorted = sortUniqueTimes(allTimes);
    return {
      timeIn: sorted[0] || 'unknown-time-in',
      timeOut: sorted[sorted.length - 1] || 'unknown-time-out',
    };
  }

  if (allTimes.length === 1) {
    return {
      timeIn: allTimes[0],
      timeOut: 'unknown-time-out',
    };
  }

  return {
    timeIn: 'unknown-time-in',
    timeOut: 'unknown-time-out',
  };
}

function extractTimeTokens(input) {
  const matches = [
    ...matchAll(input, /\b([01]?\d|2[0-3]):([0-5]\d)\s*([AaPp][Mm])\b/g),
    ...matchAll(input, /\b([01]?\d|2[0-3]):([0-5]\d)\b/g),
    ...matchAll(input, /\b([01]?\d)([0-5]\d)\s*([AaPp][Mm])\b/g),
  ];

  const normalized = [];
  const seen = new Set();

  for (const raw of matches) {
    const value = normalizeTime(raw);
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function sortUniqueTimes(times) {
  const unique = [...new Set(times)];
  unique.sort((a, b) => {
    const [ah, am] = a.split('-').map(Number);
    const [bh, bm] = b.split('-').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  });
  return unique;
}

function normalizeTime(raw) {
  const value = raw.trim().replace(/\s+/g, '');
  let match = value.match(/^([01]?\d|2[0-3]):([0-5]\d)([AaPp][Mm])$/);
  if (match) return to24Hour(match[1], match[2], match[3]);

  match = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (match) return `${pad2(match[1])}-${pad2(match[2])}`;

  match = value.match(/^([01]?\d)([0-5]\d)([AaPp][Mm])$/);
  if (match) return to24Hour(match[1], match[2], match[3]);

  return null;
}

function to24Hour(hourStr, minuteStr, ampm) {
  let hour = Number(hourStr);
  const minute = pad2(minuteStr);
  const upper = ampm.toUpperCase();

  if (upper === 'AM') {
    if (hour === 12) hour = 0;
  } else if (upper === 'PM') {
    if (hour !== 12) hour += 12;
  }

  return `${pad2(hour)}-${minute}`;
}

function buildFileName(info) {
  const parts = [info.date, info.vendor, info.timeIn, info.timeOut];
  if (info.isVisa) parts.push('visa');
  return `${parts.join('-')}.pdf`;
}

async function uniquePath(fullPath) {
  if (!(await exists(fullPath))) return fullPath;

  const dir = path.dirname(fullPath);
  const ext = path.extname(fullPath);
  const base = path.basename(fullPath, ext);

  let counter = 1;
  let candidate = path.join(dir, `${base}-${counter}${ext}`);
  while (await exists(candidate)) {
    counter += 1;
    candidate = path.join(dir, `${base}-${counter}${ext}`);
  }
  return candidate;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
      return;
    }
    throw error;
  }
}

async function appendJsonLine(filePath, data) {
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

function normalizeText(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function splitLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function slugifyVendor(input) {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^\w\s&.-]/g, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[.\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return cleaned || 'unknown-vendor';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function matchAll(input, regex) {
  return [...input.matchAll(regex)].map((m) => m[0]);
}

function getArgValue(argv, key) {
  const index = argv.indexOf(key);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function clampInt(value, min, max) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

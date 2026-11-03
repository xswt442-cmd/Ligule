import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Color } from 'pdf-lib';
import { Document, Packer, Paragraph, Table, TableRow, TableCell } from 'docx';
import ExcelJS from 'exceljs';
import type { ConditionalFormattingOptions } from 'exceljs';
import PptxGenJSImport from 'pptxgenjs';
import JSZip from 'jszip';
import { readDocument } from '../dist/capability/document.js';
import type { DocumentOptions } from '../dist/capability/document.js';
import type { CapabilityConfig, CapabilityLimits } from '../dist/capability/limits.js';

// pdfkit 没有类型声明；夹具只用它的文本写入和流式读取。
type PdfKitDocument = { text(text: string): void; end(): void } & AsyncIterable<Buffer>;
const PDFKit = createRequire(import.meta.url)('pdfkit') as new (options: {
  userPassword: string; ownerPassword: string; pdfVersion: string;
}) => PdfKitDocument;

// pptxgenjs 的类型声明把默认导出解析成命名空间；夹具只用这三个方法。
type Presentation = {
  addSlide(): { addText(text: string, options: Record<string, number>): void; addTable(rows: string[][], options: Record<string, number>): void };
  writeFile(options: { fileName: string }): Promise<unknown>;
};
const PptxGenJS = PptxGenJSImport as unknown as new () => Presentation;

async function withFiles(run: (paths: { root: string; config: CapabilityConfig }) => Promise<void>): Promise<void> {
  await mkdir(join(process.cwd(), 'testplace'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'document-'));
  const config: CapabilityConfig = { boundary: root, workspaceRoot: root };
  try { await run({ root, config }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function pdfFile(root: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 200]).drawText('First page text', { font, size: 14, x: 20, y: 150 });
  pdf.addPage([300, 200]).drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: { type: 'RGB', red: 0.2, green: 0.4, blue: 0.7 } as unknown as Color });
  await writeFile(join(root, 'sample.pdf'), await pdf.save());
}

test('isolated PDF text preserves page locations, continues, and renders a textless page as an actual image', async () => {
  await withFiles(async ({ root, config }) => {
    await pdfFile(root);
    const readPdf = async (stage: string, options: DocumentOptions) => {
      try { return await readDocument(config, options); }
      catch (error) {
        const failure = error as { code?: string; message?: string };
        throw new Error(`PDF ${stage} failed: ${failure.code ?? failure.message}`, { cause: error });
      }
    };
    const before = await readFile(join(root, 'sample.pdf'));
    const first = await readPdf('initial text extraction', { path: 'sample.pdf', count: 1 });
    assert.equal(first.result.total, 2);
    assert.equal(first.result.chunks[0].location, 'page 1');
    assert.match(first.result.chunks[0].text, /First page text/u);
    assert.equal(first.result.truncated, true);
    assert.equal(first.result.continuation!.start, 2);
    const second = await readPdf('continuation text extraction', first.result.continuation!);
    assert.equal(second.result.truncated, false);
    assert.ok(second.result.warnings.some(warning => /no text layer.*renderPage=2/u.test(warning)));
    const rendered = await readPdf('textless page rendering', { path: 'sample.pdf', renderPage: 2 });
    const metadata = await sharp(rendered.png).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 600);
    assert.equal(metadata.height, 400);
    const pixel = await sharp(rendered.png).extract({ left: 300, top: 200, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(Math.abs(pixel[0] - 51) <= 2 && Math.abs(pixel[1] - 102) <= 2 && Math.abs(pixel[2] - 179) <= 2, 'the actual rectangle, not a blank canvas, is rendered');
    const textPage = await readPdf('text page rendering', { path: 'sample.pdf', renderPage: 1 });
    const textPixels = await sharp(textPage.png).extract({ left: 35, top: 65, width: 250, height: 50 }).removeAlpha().raw().toBuffer();
    assert.ok(textPixels.filter(value => value < 100).length > 60, 'local font assets produce real visible text pixels');
    assert.deepEqual(await readFile(join(root, 'sample.pdf')), before);
    await assert.rejects(readDocument(config, { path: 'sample.pdf', renderPage: 3 }), { code: 'document_range_invalid' });
  });
});

test('DOCX uses real paragraph/table structure and byte-bounded continuation within a block', async () => {
  await withFiles(async ({ root, config }) => {
    const text = '🧪中文内容 alpha '.repeat(200);
    const document = new Document({ sections: [{ children: [new Paragraph(text),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Cell A')] }),
        new TableCell({ children: [new Paragraph('Cell B')] })] })] })] }] });
    await writeFile(join(root, 'sample.docx'), await Packer.toBuffer(document));
    await assert.rejects(readDocument(config, { path: 'sample.docx', offset: 1 }), { code: 'document_offset_invalid' });
    let options: DocumentOptions = { path: 'sample.docx', count: 1 };
    let combined = '';
    for (let tries = 0; tries < 100; tries++) {
      const { result } = await readDocument({ ...config, limits: { documentOutputBytes: 512 } as unknown as CapabilityLimits }, options);
      assert.ok(result.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0) <= 512);
      combined += result.chunks[0].text;
      if (result.continuation?.start !== 1) { options = result.continuation!; break; }
      assert.ok(result.continuation!.offset! > (options.offset ?? 0));
      options = result.continuation!;
    }
    assert.equal(combined, text);
    const table = await readDocument(config, options);
    assert.match(table.result.chunks[0].text, /Cell A\tCell B/u);
    assert.equal(table.result.truncated, false);
  });
});

test('XLSX returns sheet names, bounded requested cells, and formula/cache without evaluation', async () => {
  await withFiles(async ({ root, config }) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Values');
    sheet.getCell('A1').value = 'Label';
    sheet.getCell('B1').value = 42;
    sheet.getCell('B2').value = { formula: 'B1*2', result: 84 };
    sheet.getCell('B3').value = { formula: '1/0' };
    sheet.getCell('B4').value = { formula: 'B1-B1', result: 0 };
    sheet.getCell('B5').value = { formula: '1/0', result: { error: '#DIV/0!' } };
    sheet.getCell('B6').value = { formula: '_xlfn.XLOOKUP(1,A1:A2,B1:B2)' };
    sheet.addConditionalFormatting({ ref: 'B1:B3', rules: [{ type: 'dataBar',
      cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF63C384' } }] } as unknown as ConditionalFormattingOptions);
    workbook.addWorksheet('Other');
    await workbook.xlsx.writeFile(join(root, 'sample.xlsx'));
    const { result } = await readDocument(config, { path: 'sample.xlsx', sheet: 'Values',
      range: { startRow: 1, endRow: 6, startColumn: 2, endColumn: 2 } });
    assert.deepEqual(result.sheets, ['Values', 'Other']);
    assert.match(result.chunks[0].text, /B1: 42/u);
    assert.match(result.chunks[1].text, /formula=B1\*2; cached=84/u);
    assert.match(result.chunks[2].text, /formula=1\/0; cached=null/u);
    assert.match(result.chunks[3].text, /formula=B1-B1; cached=0/u);
    assert.match(result.chunks[4].text, /cached=\{"error":"#DIV\/0!"\}/u);
    assert.match(result.chunks[5].text, /formula=_xlfn\.XLOOKUP/u);
    assert.equal(result.chunks.some(chunk => chunk.text.includes('Label')), false);
    await assert.rejects(readDocument(config, { path: 'sample.xlsx', sheet: 'Missing' }), { code: 'document_sheet_not_found' });
  });
});

test('PPTX extracts per-slide text and table cells through the installed parser', async () => {
  await withFiles(async ({ root, config }) => {
    const presentation = new PptxGenJS();
    presentation.addSlide().addText('Slide one', { x: 1, y: 1, w: 3, h: 1 });
    presentation.addSlide().addTable([['Left', 'Right'], ['A', 'B']], { x: 1, y: 1, w: 6, h: 2 });
    await presentation.writeFile({ fileName: join(root, 'sample.pptx') });
    const first = await readDocument(config, { path: 'sample.pptx', count: 1 });
    assert.equal(first.result.total, 2);
    assert.match(first.result.chunks[0].text, /Slide one/u);
    assert.equal(first.result.continuation!.start, 2);
    const next = await readDocument(config, first.result.continuation!);
    assert.equal(next.result.chunks[0].location, 'slide 2');
    assert.match(next.result.chunks[0].text, /Left\tRight/u);
  });
});

test('document boundaries, invalid options, oversized input, malformed archives and expansion limits fail explicitly', async () => {
  await withFiles(async ({ root, config }) => {
    await writeFile(join(root, 'broken.docx'), Buffer.from('invalid archive'));
    await assert.rejects(readDocument(config, { path: '../outside.pdf' }));
    await assert.rejects(readDocument(config, { path: 'note.txt' }), { code: 'document_format_unsupported' });
    await assert.rejects(readDocument(config, { path: 'broken.docx', renderPage: 1 }), { code: 'document_options_invalid' });
    await assert.rejects(readDocument(config, { path: 'broken.docx' }), { code: 'document_parse_failed' });
    await pdfFile(root);
    await assert.rejects(readDocument({ ...config, limits: { documentBytes: 256 } }, { path: 'sample.pdf' }), { code: 'document_bytes_exceeded' });
    const zip = new JSZip();
    zip.file('word/document.xml', Buffer.alloc(65 * 1024 * 1024, 65));
    await writeFile(join(root, 'bomb.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await assert.rejects(readDocument(config, { path: 'bomb.docx' }), { code: 'document_archive_limit' });
  });
});

test('cancellation and the configured deadline wait for the actual parser process to exit', async () => {
  await withFiles(async ({ root, config }) => {
    await pdfFile(root);
    const signal = AbortSignal.timeout(100);
    await assert.rejects(readDocument(config, { path: 'sample.pdf' }, signal), { name: 'TimeoutError' });
    await assert.rejects(readDocument({ ...config, limits: { documentTimeoutMs: 1 } as unknown as CapabilityLimits }, { path: 'sample.pdf' }), { code: 'document_timeout' });
    const healthy = await readDocument(config, { path: 'sample.pdf', count: 1 });
    assert.match(healthy.result.chunks[0].text, /First page text/u);
  });
});

test('real encrypted PDFs, excessive page counts and oversized page images never masquerade as successful empty documents', async () => {
  await withFiles(async ({ root, config }) => {
    const protectedDocument = new PDFKit({ userPassword: 'document-fixture-password', ownerPassword: 'document-fixture-owner', pdfVersion: '1.7' });
    protectedDocument.text('Protected fixture text');
    protectedDocument.end();
    const chunks = [];
    for await (const chunk of protectedDocument) chunks.push(chunk);
    await writeFile(join(root, 'protected.pdf'), Buffer.concat(chunks));
    await assert.rejects(readDocument(config, { path: 'protected.pdf' }), { code: 'document_password_required' });
    const long = await PDFDocument.create();
    for (let index = 0; index < 201; index++) long.addPage([100, 100]);
    await writeFile(join(root, 'long.pdf'), await long.save());
    await assert.rejects(readDocument(config, { path: 'long.pdf' }), { code: 'document_page_limit' });
    const large = await PDFDocument.create();
    const source = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: '#4060a0' } }).jpeg().toBuffer();
    const image = await large.embedJpg(source);
    large.addPage([300, 200]).drawImage(image, { x: 0, y: 0, width: 300, height: 200 });
    await writeFile(join(root, 'large-image.pdf'), await large.save());
    await assert.rejects(readDocument(config, { path: 'large-image.pdf', renderPage: 1 }), { code: 'document_pixels_exceeded' });
  });
});

test('the parser admits two real processes, rejects excess work and releases both slots afterwards', async () => {
  await withFiles(async ({ root, config }) => {
    await pdfFile(root);
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => readDocument(config, { path: 'sample.pdf', count: 1 })));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 2);
    assert.deepEqual(outcomes.filter(item => item.status === 'rejected').map(item => item.reason.code), ['document_busy']);
    const after = await Promise.all([readDocument(config, { path: 'sample.pdf', count: 1 }), readDocument(config, { path: 'sample.pdf', count: 1 })]);
    assert.equal(after.length, 2);
  });
});

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { promises as fs } from "node:fs";
import { PDFParse } from "pdf-parse";
import { normalizeWhitespace } from "../core/text.js";
import type { ToolContext } from "../tools/types.js";

const officeXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  textNodeName: "#text"
});

export function isPdfAttachment(attachment: ToolContext["attachments"][number]) {
  return attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.originalName);
}

export function isDocxAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(attachment.originalName)
  );
}

export function isPptxAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.pptx$/i.test(attachment.originalName)
  );
}

export function isSpreadsheetAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "text/csv" ||
    attachment.mimeType === "application/vnd.ms-excel" ||
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.(csv|xls|xlsx)$/i.test(attachment.originalName)
  );
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

export function compactOfficeText(text: string, maxChars: number) {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const headLength = Math.floor(maxChars * 0.75);
  const tailLength = maxChars - headLength;
  return [
    normalized.slice(0, headLength).trimEnd(),
    `[content truncated: omitted ${normalized.length - maxChars} chars]`,
    normalized.slice(-tailLength).trimStart()
  ].join("\n\n");
}

export async function extractPdfAttachmentText(filePath: string, pages?: number[]) {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = pages?.length ? await parser.getText({ partial: pages }) : await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

export async function readSpreadsheetAttachment(
  attachment: ToolContext["attachments"][number],
  requestedSheet: string,
  maxRows: number,
  maxColumns: number
) {
  if (/\.csv$/i.test(attachment.originalName) || attachment.mimeType === "text/csv") {
    const csv = await fs.readFile(attachment.path, "utf-8");
    const rows = parseCsvRows(csv).slice(0, maxRows).map((row) => row.slice(0, maxColumns));
    return [
      `Spreadsheet read: ${attachment.originalName}`,
      "Format: CSV",
      `Rows returned: ${rows.length}`,
      "",
      formatTablePreview(rows)
    ].join("\n");
  }

  if (!/\.xlsx$/i.test(attachment.originalName)) {
    throw new Error("Only CSV and XLSX spreadsheet parsing is currently supported");
  }

  const zip = await JSZip.loadAsync(await fs.readFile(attachment.path));
  const sharedStrings = await readXlsxSharedStrings(zip);
  const workbookSheets = await readXlsxWorkbookSheets(zip);
  const selectedSheets = requestedSheet
    ? workbookSheets.filter((sheet) => sheet.name.toLowerCase() === requestedSheet.toLowerCase())
    : workbookSheets;
  const sheets = selectedSheets.length ? selectedSheets : workbookSheets.slice(0, 5);
  const previews: string[] = [];

  for (const sheet of sheets.slice(0, 5)) {
    const file = zip.file(sheet.path);
    if (!file) continue;
    const xml = await file.async("string");
    const parsed = officeXmlParser.parse(xml);
    const rows = extractSheetRows(parsed, sharedStrings, maxRows, maxColumns);
    previews.push([
      `Sheet: ${sheet.name}`,
      `Path: ${sheet.path}`,
      `Rows returned: ${rows.length}`,
      "",
      formatTablePreview(rows)
    ].join("\n"));
  }

  return [
    `Spreadsheet read: ${attachment.originalName}`,
    `Workbook sheets: ${workbookSheets.map((sheet) => sheet.name).join(", ") || "unknown"}`,
    requestedSheet && !selectedSheets.length ? `Requested sheet not found: ${requestedSheet}` : "",
    "",
    previews.join("\n\n---\n\n") || "(No readable worksheet rows found.)"
  ].filter(Boolean).join("\n");
}

export type WorkbookSheet = {
  name: string;
  columns: string[];
  rows: Array<Array<string | number | boolean>>;
};

export function ensureXlsxPath(filePath: string) {
  return /\.xlsx$/i.test(filePath) ? filePath : `${filePath.replace(/\.[^.\\/]+$/, "")}.xlsx`;
}

export function normalizeWorkbookSheets(value: unknown): WorkbookSheet[] {
  const inputSheets = Array.isArray(value) ? value : [];
  const sheets = inputSheets.map((input, index) => normalizeWorkbookSheet(input, index)).filter((sheet) => sheet.rows.length || sheet.columns.length);
  if (!sheets.length) throw new Error("At least one sheet with columns or rows is required");
  return sheets.slice(0, 12);
}

function normalizeWorkbookSheet(value: unknown, index: number): WorkbookSheet {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rowsInput = Array.isArray(input.rows) ? input.rows : [];
  const explicitColumns = Array.isArray(input.columns) ? input.columns.map((column) => String(column)) : [];
  const objectColumns = rowsInput.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []);
  const columns = uniqueStrings([...explicitColumns, ...objectColumns]).slice(0, 100);
  const rows = rowsInput.slice(0, 10_000).map((row) => normalizeWorkbookRow(row, columns)).filter((row) => row.some((cell) => String(cell).trim() !== ""));
  const name = sanitizeSheetName(String(input.name || `Sheet ${index + 1}`), index);
  return { name, columns, rows };
}

function normalizeWorkbookRow(value: unknown, columns: string[]): Array<string | number | boolean> {
  if (Array.isArray(value)) return value.slice(0, 100).map(normalizeCellScalar);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = columns.length ? columns : Object.keys(input);
    return keys.slice(0, 100).map((key) => normalizeCellScalar(input[key]));
  }
  return [normalizeCellScalar(value)];
}

function normalizeCellScalar(value: unknown): string | number | boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function sanitizeSheetName(value: string, index: number) {
  const cleaned = value.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
  return cleaned || `Sheet ${index + 1}`;
}

export async function writeXlsxWorkbook(filePath: string, sheets: WorkbookSheet[]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xlsxContentTypes(sheets.length));
  zip.folder("_rels")?.file(".rels", xlsxRootRels());
  const xl = zip.folder("xl");
  xl?.file("workbook.xml", xlsxWorkbookXml(sheets));
  xl?.file("styles.xml", xlsxStylesXml());
  xl?.folder("_rels")?.file("workbook.xml.rels", xlsxWorkbookRels(sheets.length));
  const worksheets = xl?.folder("worksheets");
  sheets.forEach((sheet, index) => worksheets?.file(`sheet${index + 1}.xml`, xlsxWorksheetXml(sheet)));
  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(filePath, content);
}

function xlsxContentTypes(sheetCount: number) {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return xmlDocument([
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    sheetOverrides,
    "</Types>"
  ].join(""));
}

function xlsxRootRels() {
  return xmlDocument([
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    "</Relationships>"
  ].join(""));
}

function xlsxWorkbookXml(sheets: WorkbookSheet[]) {
  const sheetNodes = sheets.map((sheet, index) =>
    `<sheet name="${xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join("");
  return xmlDocument([
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetNodes}</sheets>`,
    "</workbook>"
  ].join(""));
}

function xlsxWorkbookRels(sheetCount: number) {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");
  return xmlDocument([
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    sheetRels,
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"
  ].join(""));
}

function xlsxStylesXml() {
  return xmlDocument([
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
    "</styleSheet>"
  ].join(""));
}

function xlsxWorksheetXml(sheet: WorkbookSheet) {
  const rows = sheet.columns.length ? [sheet.columns, ...sheet.rows] : sheet.rows;
  const rowNodes = rows.map((row, rowIndex) => {
    const cellNodes = row.map((cell, columnIndex) => xlsxCellXml(cell, rowIndex + 1, columnIndex + 1)).join("");
    return `<row r="${rowIndex + 1}">${cellNodes}</row>`;
  }).join("");
  return xmlDocument([
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<sheetData>${rowNodes}</sheetData>`,
    "</worksheet>"
  ].join(""));
}

function xlsxCellXml(value: string | number | boolean, row: number, column: number) {
  const ref = `${columnName(column)}${row}`;
  if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
}

function columnName(index: number) {
  let value = index;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function xmlDocument(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(value: string) {
  return xmlText(value).replace(/"/g, "&quot;");
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index++;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char !== "\r") cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

async function readXlsxSharedStrings(zip: JSZip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const parsed = officeXmlParser.parse(await file.async("string"));
  const items = asArray(parsed?.sst?.si);
  return items.map((item) => collectTextNodes(item).join(""));
}

async function readXlsxWorkbookSheets(zip: JSZip) {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) {
    return zip.file(/^xl\/worksheets\/sheet\d+\.xml$/).map((file, index) => ({
      name: `Sheet ${index + 1}`,
      path: file.name
    }));
  }

  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsFile) {
    const parsedRels = officeXmlParser.parse(await relsFile.async("string"));
    for (const rel of asArray(parsedRels?.Relationships?.Relationship)) {
      if (rel?.Id && rel?.Target) {
        rels.set(String(rel.Id), `xl/${String(rel.Target).replace(/^\/?xl\//, "")}`);
      }
    }
  }

  const parsedWorkbook = officeXmlParser.parse(await workbookFile.async("string"));
  const sheets = asArray(parsedWorkbook?.workbook?.sheets?.sheet);
  return sheets.map((sheet, index) => ({
    name: String(sheet?.name || `Sheet ${index + 1}`),
    path: rels.get(String(sheet?.id || sheet?.["r:id"])) || `xl/worksheets/sheet${index + 1}.xml`
  }));
}

function extractSheetRows(parsed: unknown, sharedStrings: string[], maxRows: number, maxColumns: number) {
  const worksheet = parsed as { worksheet?: { sheetData?: { row?: unknown } } };
  const rows = asArray(worksheet?.worksheet?.sheetData?.row);
  return rows.slice(0, maxRows).map((row) => {
    const cells = asArray((row as { c?: unknown })?.c);
    return cells.slice(0, maxColumns).map((cell) => cellValue(cell, sharedStrings));
  });
}

function cellValue(cell: unknown, sharedStrings: string[]) {
  const input = cell as { t?: string; v?: unknown; is?: unknown };
  const rawValue = valueText(input?.v);
  if (input?.t === "s") return sharedStrings[Number(rawValue)] || "";
  if (input?.t === "inlineStr") return collectTextNodes(input.is).join("");
  return rawValue;
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "#text" in value) return String((value as Record<string, unknown>)["#text"] || "");
  return String(value);
}

function formatTablePreview(rows: string[][]) {
  if (!rows.length) return "(No rows found.)";
  return rows
    .map((row, index) => {
      const cells = row.map((cell) => normalizeWhitespace(cell).slice(0, 120));
      return `${index + 1}: ${cells.join(" | ")}`;
    })
    .join("\n");
}

export async function inspectPresentationAttachment(filePath: string, originalName: string, maxSlides: number, maxCharsPerSlide: number) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const slideFiles = zip
    .file(/^ppt\/slides\/slide\d+\.xml$/)
    .sort((left, right) => numericSuffix(left.name) - numericSuffix(right.name))
    .slice(0, maxSlides);
  const slides: string[] = [];

  for (const file of slideFiles) {
    const parsed = officeXmlParser.parse(await file.async("string"));
    const texts = collectTextNodes(parsed).map(normalizeWhitespace).filter(Boolean);
    const body = compactOfficeText(texts.join("\n"), maxCharsPerSlide);
    slides.push([
      `Slide ${numericSuffix(file.name) || slides.length + 1}`,
      body || "(No readable text found.)"
    ].join("\n"));
  }

  return [
    `PPTX inspected: ${originalName}`,
    `Slides returned: ${slides.length}`,
    "",
    slides.join("\n\n---\n\n") || "(No readable slides found.)"
  ].join("\n");
}

function collectTextNodes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap(collectTextNodes);
  if (typeof value !== "object") return [];
  const input = value as Record<string, unknown>;
  const current = typeof input.t === "string" || typeof input.t === "number" ? [String(input.t)] : [];
  const textNode = typeof input["#text"] === "string" || typeof input["#text"] === "number" ? [String(input["#text"])] : [];
  const nested = Object.entries(input)
    .filter(([key]) => key !== "t" && key !== "#text")
    .flatMap(([, child]) => collectTextNodes(child));
  return [...current, ...textNode, ...nested];
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function numericSuffix(value: string) {
  return Number(value.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
}

export function findContextAttachment(context: ToolContext, attachmentId: string) {
  return context.attachments.find((attachment) => attachment.id === attachmentId);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

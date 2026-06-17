import mammoth from "mammoth";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  clampNumber,
  compactOfficeText,
  ensureXlsxPath,
  extractPdfAttachmentText,
  findContextAttachment,
  inspectPresentationAttachment,
  isDocxAttachment,
  isPdfAttachment,
  isPptxAttachment,
  isSpreadsheetAttachment,
  normalizeWorkbookSheets,
  readSpreadsheetAttachment,
  writeXlsxWorkbook
} from "../attachments/office.js";
import {
  diffGeneratedFiles,
  formatCommandForDisplay,
  inferTestCommand,
  normalizeImageFormat,
  snapshotGeneratedFiles
} from "../core/local-files.js";
import { safeResolvePath, sanitizeFileName } from "../core/paths.js";
import { normalizeWhitespace, stripAnsi } from "../core/text.js";
import { executeStructuredCommand, normalizeCommandInput } from "./command.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext, ToolDefinition, ToolHandler, ToolMetadata } from "./types.js";
import { compactJsonText, formatFetchedPage, htmlToReadableText, looksLikeHtml } from "../web/readability.js";
import {
  attachFetchedExcerpts,
  openWebSearch,
  parseSearchEngines,
  parseSearchMode,
  rankWebSearchResults
} from "../web/search.js";
import type { Attachment, Skill } from "../domain/types.js";

const execFileAsync = promisify(execFile);

type RegisterServerToolsDependencies = {
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  claudeCodeExecutable: string;
  claudeCodeArgs: string[];
  claudeCodeTimeoutMs: number;
  attachments: Map<string, Attachment>;
  persistStore: () => Promise<void>;
  searchSkillCatalog: (query: string) => Array<Record<string, unknown> & { id: string }>;
  loadSkillById: (skillId: string, source?: Skill["source"]) => Skill | undefined;
  publicSkillSummary: (skill: any) => unknown;
  resolveGeneratedFilePath: (inputPath: string, context: ToolContext) => string;
  resolveCommandCwd: (cwd: unknown, context: ToolContext) => Promise<string>;
  buildClaudeCodePrompt: (task: string, mode: string, context: ToolContext, cwd: string) => string;
  formatAttachmentLine: (attachment: ToolContext["attachments"][number]) => string;
  requireAttachment: (context: ToolContext, attachmentId: string) => ToolContext["attachments"][number];
  getWebBridgeStatus: () => Promise<{ running: boolean; extension_connected: boolean; port: number; version: string; extension_version?: string }>;
  callWebBridge: (action: string, args: unknown, session: string) => Promise<unknown>;
  summarizeWebBridgePayload: (action: string, payload: unknown) => string;
  id: (prefix: string) => string;
  now: () => string;
};

export function registerServerTools(deps: RegisterServerToolsDependencies) {
  const {
    toolRegistry,
    workspaceRoot,
    claudeCodeExecutable,
    claudeCodeArgs,
    claudeCodeTimeoutMs,
    attachments,
    persistStore,
    searchSkillCatalog,
    loadSkillById,
    publicSkillSummary,
    resolveGeneratedFilePath,
    resolveCommandCwd,
    buildClaudeCodePrompt,
    formatAttachmentLine,
    requireAttachment,
    getWebBridgeStatus,
    callWebBridge,
    summarizeWebBridgePayload,
    id,
    now
  } = deps;
  const registerTool = (
    definition: ToolDefinition,
    metadata: ToolMetadata,
    handler: ToolHandler
  ) => {
    toolRegistry.register(definition, metadata, handler);
  };

  registerTool(
    {
      type: "function",
      function: {
        name: "discover_or_load_skill",
        description: "Search the SuperCodex skill catalog and load a relevant skill/tool package for the current task. Use this when a request mentions a capability that is missing, unclear, or better handled by a specialized office skill.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Capability or task to search for, e.g. academic PDF summary, PPT, Excel analysis, HTML report" },
            skillId: { type: "string", description: "Optional exact skill id to load from the catalog" },
            connect: { type: "boolean", description: "Whether to connect/load the selected skill. Defaults to true." }
          }
        }
      }
    },
    {
      riskLevel: "read",
      permissions: [],
      timeoutMs: 5_000,
      categories: ["orchestration"],
      keywords: ["skill", "tool", "能力", "工具", "加载"]
    },
    async (args) => {
      const query = String(args.query || args.skillId || "");
      const matches = searchSkillCatalog(query);
      const exact = args.skillId ? matches.find((skill) => skill.id === String(args.skillId)) : undefined;
      const selected = exact || matches[0];
      const shouldConnect = args.connect !== false;
      const loaded = selected && shouldConnect ? loadSkillById(selected.id, "discovered") : undefined;
      if (loaded) {
        loaded.connected = true;
        loaded.installed = true;
        loaded.lastLoadedAt = now();
        await persistStore();
      }
      return {
        ok: true,
        summary: loaded
          ? `Loaded skill: ${loaded.title}`
          : matches.length
            ? `Found ${matches.length} matching skills.`
            : "No matching skills found in the local catalog.",
        data: {
          query,
          loaded,
          matches: matches.slice(0, 6).map(publicSkillSummary)
        }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files and directories inside the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path" } }
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const dirPath = safeResolvePath(String(args.path || "."), context.workspacePath);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file inside the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            limit: { type: "number", description: "Max lines" }
          },
          required: ["path"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const filePath = safeResolvePath(String(args.path || ""), context.workspacePath);
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const visible = lines.slice(0, limit).join("\n");
      return lines.length > limit ? `${visible}\n\n... (${lines.length - limit} more lines)` : visible;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a text file inside the workspace. Bare file names are written to the generated files directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:write"],
      producesArtifacts: true,
      timeoutMs: 10_000,
      categories: ["files", "documents", "html", "presentation", "spreadsheet", "office"],
      skillIds: ["files", "slides", "pdf", "html", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const filePath = resolveGeneratedFilePath(String(args.path || ""), context);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(args.content || ""), "utf-8");
      return `File written: ${path.relative(context.workspacePath, filePath)}`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a safe structured command. Prefer executable plus args. Legacy command strings are accepted only when they do not use shell operators. If cwd is omitted, it runs in the generated files directory for scripts and intermediate outputs.",
        parameters: {
          type: "object",
          properties: {
            executable: { type: "string", description: "Executable name or path, e.g. npm, node, rg" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments passed directly to the executable"
            },
            command: { type: "string", description: "Legacy command string for simple commands without shell operators" },
            cwd: { type: "string", description: "Working directory" }
          }
        }
      }
    },
    {
      riskLevel: "shell",
      permissions: ["shell:run", "workspace:read", "workspace:write"],
      producesArtifacts: true,
      timeoutMs: 30_000,
      categories: ["office", "documents", "presentation", "pdf", "spreadsheet", "html"],
      skillIds: ["slides", "pdf", "html", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const command = normalizeCommandInput(args);
      const cwd = await resolveCommandCwd(args.cwd, context);
      const beforeFiles = await snapshotGeneratedFiles(context.outputPath);
      const result = await executeStructuredCommand(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 5
      });
      const generatedFiles = diffGeneratedFiles(beforeFiles, await snapshotGeneratedFiles(context.outputPath), context);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const generatedOutput = generatedFiles.map((filePath) => `Generated file: ${filePath}`).join("\n");
      return [
        `Command executed (${command.source}): ${command.display}`,
        output || "(Command succeeded, no output)",
        generatedOutput
      ].filter(Boolean).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "delegate_to_claude_code",
        description: "Delegate a coding or local project task to Claude Code. Use this as the preferred executor for implementation, refactoring, debugging, tests, and repository changes; SuperCodex should supervise the result and summarize it for the user.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Precise task for Claude Code, including expected files, behavior, constraints, and verification requirements."
            },
            cwd: {
              type: "string",
              description: "Working directory for Claude Code. Defaults to the current project workspace."
            },
            mode: {
              type: "string",
              enum: ["implement", "inspect", "test"],
              description: "Whether Claude Code should implement changes, inspect/report only, or focus on tests. Defaults to implement."
            },
            timeoutMs: {
              type: "number",
              description: "Optional timeout in milliseconds. Defaults to CLAUDE_CODE_TIMEOUT_MS or 600000."
            }
          },
          required: ["task"]
        }
      }
    },
    {
      riskLevel: "shell",
      permissions: ["shell:run", "workspace:read", "workspace:write"],
      producesArtifacts: true,
      timeoutMs: claudeCodeTimeoutMs,
      categories: ["code"],
      keywords: ["claude", "claude code", "代码", "实现", "修复", "重构", "测试", "coding", "implementation"]
    },
    async (args, context) => {
      const task = normalizeWhitespace(String(args.task || ""));
      if (!task) throw new Error("task is required");

      const cwd = await resolveCommandCwd(args.cwd || context.workspacePath, context);
      const mode = String(args.mode || "implement");
      const timeoutMs = Math.max(10_000, Math.min(Number(args.timeoutMs) || claudeCodeTimeoutMs, 3_600_000));
      const prompt = buildClaudeCodePrompt(task, mode, context, cwd);
      const command = {
        executable: claudeCodeExecutable,
        args: [...claudeCodeArgs, prompt],
        display: formatCommandForDisplay([claudeCodeExecutable, ...claudeCodeArgs, "<task prompt>"]),
        source: "argv" as const
      };

      const beforeGeneratedFiles = await snapshotGeneratedFiles(context.outputPath);
      try {
        const result = await executeStructuredCommand(command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 20
        });
        const generatedFiles = diffGeneratedFiles(beforeGeneratedFiles, await snapshotGeneratedFiles(context.outputPath), context);
        return {
          ok: true,
          summary: "Claude Code completed the delegated task.",
          stdout: result.stdout,
          stderr: result.stderr,
          data: {
            cwd,
            mode,
            command: command.display,
            generatedFiles
          }
        };
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; code?: number; signal?: string };
        return {
          ok: false,
          summary: `Claude Code delegation failed${err.code ? ` with exit code ${err.code}` : ""}.`,
          stdout: err.stdout,
          stderr: err.stderr || err.message,
          error: err.message,
          data: {
            cwd,
            mode,
            command: command.display,
            signal: err.signal
          }
        };
      }
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search text in files inside the current project workspace using ripgrep.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text or regex to search for" },
            path: { type: "string", description: "Optional subdirectory" },
            glob: { type: "string", description: "Optional glob, e.g. *.ts" }
          },
          required: ["query"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 20_000
    },
    async (args, context) => {
      const query = String(args.query || "");
      const subPath = safeResolvePath(String(args.path || "."), context.workspacePath);
      const command = ["rg", "--line-number", "--hidden", "--glob", "!node_modules", "--glob", "!.git"];
      if (args.glob) command.push("--glob", String(args.glob));
      command.push(query, subPath);
      const result = await execFileAsync(command[0], command.slice(1), {
        cwd: context.workspacePath,
        timeout: 20_000,
        maxBuffer: 1024 * 1024 * 2
      }).catch((error: Error & { stdout?: string; stderr?: string; code?: number }) => {
        if (error.code === 1) return { stdout: "", stderr: "" };
        throw error;
      });
      return result.stdout.trim() || "No matches found.";
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "Replace text in a file inside the current project workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            search: { type: "string", description: "Exact text to replace" },
            replace: { type: "string", description: "Replacement text" }
          },
          required: ["path", "search", "replace"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:read", "workspace:write"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const filePath = safeResolvePath(String(args.path || ""), context.workspacePath);
      const search = String(args.search || "");
      const replace = String(args.replace || "");
      if (!search) throw new Error("search text is required");
      const content = await fs.readFile(filePath, "utf-8");
      if (!content.includes(search)) return `Text not found in ${path.relative(context.workspacePath, filePath)}`;
      const occurrences = content.split(search).length - 1;
      await fs.writeFile(filePath, content.split(search).join(replace), "utf-8");
      return `Updated ${path.relative(context.workspacePath, filePath)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the current project's test or build command.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Test command. Defaults to npm test if package.json exists, otherwise npm run build"
            }
          }
        }
      }
    },
    {
      riskLevel: "shell",
      permissions: ["shell:run", "workspace:read"],
      timeoutMs: 120_000
    },
    async (args, context) => {
      const command = normalizeCommandInput({
        command: String(args.command || (await inferTestCommand(context.workspacePath)))
      });
      try {
        const result = await executeStructuredCommand(command, {
          cwd: context.workspacePath,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 5
        });
        return [
          `Command executed (${command.source}): ${command.display}`,
          [result.stdout, result.stderr].filter(Boolean).join("\n") || "(Tests completed, no output)"
        ].join("\n");
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; code?: number };
        return [
          `Command failed (${err.code ?? 1}): ${command.display}`,
          err.stdout || "",
          err.stderr || err.message
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "list_attachments",
        description: "List files and images uploaded or pasted into the current conversation.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 5_000
    },
    async (_args, context) => {
      if (!context.attachments.length) return "No attachments in this conversation.";
      return context.attachments.map(formatAttachmentLine).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_attachment",
        description: "Read a text attachment or return metadata for an uploaded image/file.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Attachment id from list_attachments" },
            limit: { type: "number", description: "Max lines for text attachments" }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 10_000,
      categories: ["files", "documents", "pdf", "spreadsheet", "office"],
      skillIds: ["files", "pdf", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const attachment = findContextAttachment(context, String(args.attachmentId || ""));
      if (!attachment) throw new Error("Attachment not found in this conversation");
      if (attachment.kind !== "text") return formatAttachmentLine(attachment);
      const limit = Math.max(1, Math.min(Number(args.limit) || 300, 1200));
      const content = await fs.readFile(attachment.path, "utf-8");
      const lines = content.split("\n");
      const visible = lines.slice(0, limit).join("\n");
      return lines.length > limit ? `${visible}\n\n... (${lines.length - limit} more lines)` : visible;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "extract_pdf_text",
        description: "Extract readable text from an uploaded PDF attachment for summary, review, citation, or conversion tasks.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "PDF attachment id from list_attachments" },
            pages: {
              type: "array",
              items: { type: "number" },
              description: "Optional 1-based page numbers to extract. Omit to extract the full PDF."
            },
            maxChars: { type: "number", description: "Maximum characters to return, 2000-50000. Defaults to 20000." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 30_000,
      categories: ["pdf", "documents", "office", "research"],
      skillIds: ["pdf", "documents", "academic"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isPdfAttachment(attachment)) throw new Error("Attachment is not a PDF");
      const maxChars = clampNumber(args.maxChars, 2_000, 50_000, 20_000);
      const pages = Array.isArray(args.pages)
        ? args.pages.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page > 0)
        : undefined;
      const text = await extractPdfAttachmentText(attachment.path, pages);
      const compact = compactOfficeText(text, maxChars);
      return {
        ok: true,
        summary: [
          `PDF extracted: ${attachment.originalName}`,
          pages?.length ? `Pages: ${pages.join(", ")}` : "Pages: all available pages",
          `Characters returned: ${compact.length}`,
          "",
          compact || "(No readable text found. The PDF may be scanned or image-only.)"
        ].join("\n"),
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName, pages }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_spreadsheet",
        description: "Read an uploaded CSV/XLS/XLSX spreadsheet and return workbook sheets, headers, sample rows, and basic dimensions.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Spreadsheet attachment id from list_attachments" },
            sheet: { type: "string", description: "Optional sheet name to inspect for XLSX files" },
            maxRows: { type: "number", description: "Maximum rows per sheet to return, 5-100. Defaults to 30." },
            maxColumns: { type: "number", description: "Maximum columns per row to return, 3-50. Defaults to 20." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["spreadsheet", "office"],
      skillIds: ["excel"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isSpreadsheetAttachment(attachment)) throw new Error("Attachment is not a supported spreadsheet");
      const maxRows = clampNumber(args.maxRows, 5, 100, 30);
      const maxColumns = clampNumber(args.maxColumns, 3, 50, 20);
      const result = await readSpreadsheetAttachment(attachment, String(args.sheet || ""), maxRows, maxColumns);
      return {
        ok: true,
        summary: result,
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "extract_docx_text",
        description: "Extract readable text from an uploaded Word DOCX attachment for rewriting, summary, or report tasks.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "DOCX attachment id from list_attachments" },
            maxChars: { type: "number", description: "Maximum characters to return, 2000-50000. Defaults to 20000." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["documents", "office"],
      skillIds: ["documents"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isDocxAttachment(attachment)) throw new Error("Attachment is not a DOCX file");
      const maxChars = clampNumber(args.maxChars, 2_000, 50_000, 20_000);
      const result = await mammoth.extractRawText({ path: attachment.path });
      const compact = compactOfficeText(result.value, maxChars);
      const warnings = result.messages?.map((message) => message.message).filter(Boolean) || [];
      return {
        ok: true,
        summary: [
          `DOCX extracted: ${attachment.originalName}`,
          warnings.length ? `Warnings: ${warnings.slice(0, 5).join("; ")}` : "",
          `Characters returned: ${compact.length}`,
          "",
          compact || "(No readable text found.)"
        ].filter(Boolean).join("\n"),
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName, warnings }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "create_spreadsheet",
        description: "Create an XLSX workbook artifact from structured sheet data. Use this for cleaned data, analysis tables, trackers, and office-ready spreadsheet deliverables.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output .xlsx path. Bare file names are written to the generated files directory." },
            sheets: {
              type: "array",
              description: "Workbook sheets. Each sheet has name, optional columns, and rows. Rows can be arrays or objects.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  columns: { type: "array", items: { type: "string" } },
                  rows: { type: "array", items: {} }
                }
              }
            }
          },
          required: ["path", "sheets"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:write"],
      producesArtifacts: true,
      timeoutMs: 20_000,
      categories: ["spreadsheet", "office"],
      skillIds: ["excel"]
    },
    async (args, context) => {
      const outputPath = ensureXlsxPath(resolveGeneratedFilePath(String(args.path || "spreadsheet.xlsx"), context));
      const sheets = normalizeWorkbookSheets(args.sheets);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await writeXlsxWorkbook(outputPath, sheets);
      const relativePath = path.relative(context.workspacePath, outputPath);
      return {
        ok: true,
        summary: [
          `Generated file: ${relativePath}`,
          `Workbook sheets: ${sheets.map((sheet) => `${sheet.name} (${sheet.rows.length} rows)`).join(", ")}`
        ].join("\n"),
        artifacts: [{ title: path.basename(outputPath), path: relativePath, kind: "table" }],
        metadata: { path: relativePath, sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })) }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "inspect_presentation",
        description: "Inspect an uploaded PPTX presentation and return slide titles/text for review, rewriting, or deck generation.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "PPTX attachment id from list_attachments" },
            maxSlides: { type: "number", description: "Maximum slides to return, 1-80. Defaults to 30." },
            maxCharsPerSlide: { type: "number", description: "Maximum text characters per slide, 300-4000. Defaults to 1500." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["presentation", "office"],
      skillIds: ["slides"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isPptxAttachment(attachment)) throw new Error("Attachment is not a PPTX file");
      const maxSlides = clampNumber(args.maxSlides, 1, 80, 30);
      const maxCharsPerSlide = clampNumber(args.maxCharsPerSlide, 300, 4_000, 1_500);
      const summary = await inspectPresentationAttachment(attachment.path, attachment.originalName, maxSlides, maxCharsPerSlide);
      return {
        ok: true,
        summary,
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "transform_image",
        description: "Create a modified copy of an uploaded image. Supports resize, crop, rotate, grayscale, blur, sharpen, flip, flop, and format conversion.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Image attachment id" },
            outputName: { type: "string", description: "Optional output file name" },
            width: { type: "number", description: "Resize width in pixels" },
            height: { type: "number", description: "Resize height in pixels" },
            crop: {
              type: "object",
              properties: {
                left: { type: "number" },
                top: { type: "number" },
                width: { type: "number" },
                height: { type: "number" }
              }
            },
            rotate: { type: "number", description: "Rotation degrees" },
            grayscale: { type: "boolean" },
            blur: { type: "number" },
            sharpen: { type: "boolean" },
            flip: { type: "boolean" },
            flop: { type: "boolean" },
            format: { type: "string", description: "png, jpeg, or webp" }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["attachments:read", "attachments:write", "workspace:write"],
      producesArtifacts: true,
      timeoutMs: 30_000
    },
    async (args, context) => {
      const attachment = findContextAttachment(context, String(args.attachmentId || ""));
      if (!attachment) throw new Error("Attachment not found in this conversation");
      if (attachment.kind !== "image") throw new Error("Attachment is not an image");

      const format = normalizeImageFormat(String(args.format || path.extname(attachment.originalName).slice(1) || "png"));
      const outputName =
        sanitizeFileName(String(args.outputName || "")) ||
        `${path.parse(attachment.originalName).name}-edited.${format === "jpeg" ? "jpg" : format}`;
      const artifactDir = context.outputPath;
      await fs.mkdir(artifactDir, { recursive: true });
      const outputPath = path.join(artifactDir, `${id("image")}-${outputName}`);

      let pipeline = sharp(attachment.path);
      const crop = args.crop as Record<string, unknown> | undefined;
      if (crop) {
        pipeline = pipeline.extract({
          left: Math.max(0, Number(crop.left) || 0),
          top: Math.max(0, Number(crop.top) || 0),
          width: Math.max(1, Number(crop.width) || 1),
          height: Math.max(1, Number(crop.height) || 1)
        });
      }
      if (args.width || args.height) {
        pipeline = pipeline.resize({
          width: args.width ? Math.max(1, Number(args.width)) : undefined,
          height: args.height ? Math.max(1, Number(args.height)) : undefined,
          fit: "inside",
          withoutEnlargement: false
        });
      }
      if (args.rotate) pipeline = pipeline.rotate(Number(args.rotate));
      if (args.grayscale) pipeline = pipeline.grayscale();
      if (args.blur) pipeline = pipeline.blur(Math.max(0.3, Math.min(Number(args.blur), 100)));
      if (args.sharpen) pipeline = pipeline.sharpen();
      if (args.flip) pipeline = pipeline.flip();
      if (args.flop) pipeline = pipeline.flop();
      await pipeline.toFormat(format).toFile(outputPath);

      const stat = await fs.stat(outputPath);
      const derived: Attachment = {
        id: id("attachment"),
        conversationId: attachment.conversationId,
        originalName: outputName,
        fileName: path.basename(outputPath),
        mimeType: `image/${format}`,
        size: stat.size,
        path: outputPath,
        kind: "image",
        source: "artifact",
        createdAt: now(),
        derivedFrom: attachment.id
      };
      attachments.set(derived.id, derived);
      await persistStore();
      return `Created image attachment ${derived.id}: ${derived.originalName}\nURL: /api/attachments/${derived.id}/content\nPath: ${derived.path}`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch a URL and return cleaned readable content, not raw HTML.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to fetch" } },
          required: ["url"]
        }
      }
    },
    {
      riskLevel: "network",
      permissions: ["network:fetch"],
      timeoutMs: 30_000,
      categories: ["search", "research"],
      skillIds: ["search", "academic"]
    },
    async (args) => {
      const url = String(args.url || "");
      if (!/^https?:\/\//.test(url)) throw new Error("Only http/https URLs are allowed");
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      if (contentType.includes("text/html") || looksLikeHtml(text)) {
        return formatFetchedPage(url, text);
      }
      if (contentType.includes("application/json")) {
        return compactJsonText(text, 8000);
      }
      return normalizeWhitespace(stripAnsi(text)).slice(0, 8000);
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web for information. Returns compact top results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            num: { type: "number", description: "Number of final ranked results, 1-8" },
            engines: {
              type: "array",
              items: { type: "string" },
              description: "Optional search engines to combine: bing, duckduckgo, brave, startpage, baidu, sogou, exa, csdn, juejin, linuxdo"
            },
            searchMode: {
              type: "string",
              enum: ["request", "auto", "playwright"],
              description: "Optional open-websearch mode. playwright can improve Bing quality but is slower."
            },
            fetchTop: {
              type: "number",
              description: "Fetch readable content from the top N ranked pages for verification, 0-4. Defaults to 3."
            }
          },
          required: ["query"]
        }
      }
    },
    {
      riskLevel: "network",
      permissions: ["network:fetch"],
      timeoutMs: 45_000,
      categories: ["search", "research"],
      skillIds: ["search", "academic"]
    },
    async (args) => {
      const query = String(args.query || "");
      const num = Math.max(1, Math.min(Number(args.num) || 5, 8));
      const engines = parseSearchEngines(args.engines);
      const searchMode = parseSearchMode(args.searchMode);
      const fetchTop = Math.max(0, Math.min(Number(args.fetchTop ?? 3) || 0, 4));
      const requestedLimit = Math.min(50, Math.max(num * 3, num * Math.max(1, engines.length)));
      const payload = await openWebSearch(workspaceRoot, query, requestedLimit, { engines, searchMode });
      if (!payload.results.length) {
        const failures = payload.partialFailures?.length ? `\nPartial failures: ${JSON.stringify(payload.partialFailures).slice(0, 1000)}` : "";
        return `No results found.${failures}`;
      }
      const ranked = rankWebSearchResults(query, payload.results).slice(0, num);
      await attachFetchedExcerpts(ranked, fetchTop);
      const failureNote = payload.partialFailures?.length
        ? `\n\nPartial search failures:\n${JSON.stringify(payload.partialFailures, null, 2).slice(0, 1500)}`
        : "";
      return [
        `Search query: ${payload.query}`,
        `Engines: ${payload.engines.join(", ")}`,
        `Retrieved: ${payload.totalResults}; returned ranked: ${ranked.length}`,
        "",
        ...ranked
        .map((result, index) =>
          [
            `${index + 1}. ${result.title}`,
            `URL: ${result.url}`,
            `Domain: ${result.domain}`,
            `Score: ${result.rankScore}`,
            result.description ? `Description: ${result.description}` : "",
            result.engine ? `Engine: ${result.engine}` : "",
            result.qualitySignals.length ? `Signals: ${result.qualitySignals.join(", ")}` : "",
            result.matchedTerms.length ? `Matched terms: ${result.matchedTerms.join(", ")}` : "",
            result.fetched?.title ? `Fetched title: ${result.fetched.title}` : "",
            result.fetched?.description ? `Fetched description: ${result.fetched.description}` : "",
            result.fetched?.excerpt ? `Fetched excerpt: ${result.fetched.excerpt}` : "",
            result.fetchError ? `Fetch warning: ${result.fetchError}` : ""
          ].filter(Boolean).join("\n")
        )
        .join("\n\n"),
        failureNote
      ].filter(Boolean).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "webbridge_status",
        description: "Check Kimi WebBridge daemon and browser extension status.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      riskLevel: "external",
      permissions: ["external:webbridge"],
      timeoutMs: 10_000,
      categories: ["browser"],
      skillIds: ["webbridge"]
    },
    async () => {
      return JSON.stringify(await getWebBridgeStatus());
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "webbridge_command",
        description: "Send a safe command to Kimi WebBridge for real-browser work. Supports status-independent actions such as list_tabs and snapshot when extension is connected.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "One of: list_tabs, snapshot, navigate, find_tab"
            },
            args: {
              type: "object",
              description: "Arguments for the WebBridge action"
            },
            session: {
              type: "string",
              description: "Stable session name for this task"
            }
          },
          required: ["action", "session"]
        }
      }
    },
    {
      riskLevel: "external",
      permissions: ["external:webbridge"],
      timeoutMs: 30_000,
      categories: ["browser", "html"],
      skillIds: ["webbridge", "html"]
    },
    async (args) => {
      const action = String(args.action || "");
      if (!["list_tabs", "snapshot", "navigate", "find_tab"].includes(action)) {
        throw new Error(`Unsupported WebBridge action: ${action}`);
      }
      const payload = await callWebBridge(action, args.args ?? {}, String(args.session || "supercodex"));
      return summarizeWebBridgePayload(action, payload);
    }
  );
}

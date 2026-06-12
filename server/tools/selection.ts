import type { RegisteredTool, ToolContext } from "./types.js";

const alwaysAvailable = new Set([
  "list_directory",
  "read_file",
  "write_file",
  "search_files",
  "replace_in_file",
  "run_tests",
  "list_attachments",
  "read_attachment",
  "discover_or_load_skill"
]);

const codeTaskPattern = /项目|代码|文件|目录|构建|测试|运行|命令|终端|脚本|bug|修复|实现|改动|refactor|build|test|npm|node|git|rg|shell|command/i;
const webTaskPattern = /网页|网址|链接|浏览器|搜索|联网|新闻|资讯|最新|今天|昨日|昨天|查一下|查找|打开|http|https|web|search|browser|url/i;
const imageTaskPattern = /图片|图像|照片|截图|裁剪|缩放|旋转|灰度|模糊|锐化|格式|image|photo|screenshot|resize|crop/i;
const browserTaskPattern = /webbridge|浏览器|打开网页|控制网页|真实浏览器|browser|tab|snapshot/i;
const shellTaskPattern = /命令|终端|运行|执行|安装|构建|测试|脚本|npm|node|git|rg|shell|command|install|build|test/i;
const officeTaskPattern = /学术|论文|研究|文献|引用|ppt|幻灯片|演示|pdf|html|excel|表格|数据|csv|xlsx|docx|word|报告|academic|paper|research|citation|slides|presentation|spreadsheet/i;
const pdfTaskPattern = /pdf|论文|文献|paper|article/i;
const spreadsheetTaskPattern = /excel|表格|数据|csv|xlsx|xls|sheet|spreadsheet|公式/i;
const documentTaskPattern = /docx|word|文档|报告|润色|写作|document/i;
const presentationTaskPattern = /ppt|pptx|幻灯片|演示|deck|slides|presentation/i;

export function selectToolsForTask(
  tools: RegisteredTool[],
  input: {
    prompt: string;
    context: ToolContext;
    activeSkillIds?: string[];
    activeSkillCategories?: string[];
    activeSkillKeywords?: string[];
  }
) {
  const prompt = input.prompt.trim();
  const skillText = [...(input.activeSkillCategories || []), ...(input.activeSkillKeywords || [])].join(" ");
  const selectorText = `${prompt} ${skillText}`;
  const activeSkillIds = new Set(input.activeSkillIds || []);
  const activeCategories = new Set((input.activeSkillCategories || []).map((category) => category.toLowerCase()));
  const hasAttachments = input.context.attachments.length > 0;
  const hasImages = input.context.attachments.some((attachment) => attachment.kind === "image");
  const hasPdfAttachment = input.context.attachments.some(isPdfAttachment);
  const hasSpreadsheetAttachment = input.context.attachments.some(isSpreadsheetAttachment);
  const hasDocumentAttachment = input.context.attachments.some(isDocumentAttachment);
  const hasPresentationAttachment = input.context.attachments.some(isPresentationAttachment);
  const includeOfficeTools = officeTaskPattern.test(selectorText) || activeCategories.has("office") || activeCategories.has("research");
  const includePdf = pdfTaskPattern.test(selectorText) || activeCategories.has("pdf");
  const includeSpreadsheet = spreadsheetTaskPattern.test(selectorText) || activeCategories.has("spreadsheet");
  const includeDocuments = documentTaskPattern.test(selectorText) || activeCategories.has("documents");
  const includePresentation = presentationTaskPattern.test(selectorText) || activeCategories.has("presentation");
  const includeShell = shellTaskPattern.test(selectorText) || codeTaskPattern.test(selectorText) || includeOfficeTools;
  const includeWeb = webTaskPattern.test(selectorText) || activeCategories.has("search") || activeCategories.has("research");
  const includeImages = hasImages || imageTaskPattern.test(selectorText);
  const includeBrowser = browserTaskPattern.test(selectorText) || activeCategories.has("browser");

  return tools.filter((tool) => {
    const name = tool.definition.function.name;
    const metadata = tool.metadata;
    if (metadata.skillIds?.some((skillId) => activeSkillIds.has(skillId))) return true;
    if (metadata.categories?.some((category) => activeCategories.has(category.toLowerCase()))) return true;
    if (alwaysAvailable.has(name)) return true;
    if (name === "run_command") return includeShell;
    if (name === "fetch_url" || name === "search_web") return includeWeb;
    if (name === "transform_image") return includeImages;
    if (name === "webbridge_status" || name === "webbridge_command") return includeBrowser;
    if (name === "extract_pdf_text") return hasPdfAttachment || includePdf;
    if (name === "read_spreadsheet") return hasSpreadsheetAttachment || includeSpreadsheet;
    if (name === "create_spreadsheet") return includeSpreadsheet;
    if (name === "extract_docx_text") return hasDocumentAttachment || includeDocuments;
    if (name === "inspect_presentation") return hasPresentationAttachment || includePresentation;
    if (tool.metadata.permissions.includes("attachments:read")) return hasAttachments;
    if (metadata.categories?.includes("office")) return includeOfficeTools;
    return false;
  });
}

function isPdfAttachment(attachment: ToolContext["attachments"][number]) {
  return attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.originalName);
}

function isSpreadsheetAttachment(attachment: ToolContext["attachments"][number]) {
  return /(?:csv|excel|spreadsheet|sheet)/i.test(attachment.mimeType) || /\.(csv|xls|xlsx)$/i.test(attachment.originalName);
}

function isDocumentAttachment(attachment: ToolContext["attachments"][number]) {
  return /wordprocessingml|msword/i.test(attachment.mimeType) || /\.(doc|docx)$/i.test(attachment.originalName);
}

function isPresentationAttachment(attachment: ToolContext["attachments"][number]) {
  return /presentation|powerpoint/i.test(attachment.mimeType) || /\.(ppt|pptx)$/i.test(attachment.originalName);
}

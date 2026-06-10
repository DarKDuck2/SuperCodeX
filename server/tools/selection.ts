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
  const includeOfficeTools = officeTaskPattern.test(selectorText) || activeCategories.has("office") || activeCategories.has("research");
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
    if (tool.metadata.permissions.includes("attachments:read")) return hasAttachments;
    return true;
  });
}

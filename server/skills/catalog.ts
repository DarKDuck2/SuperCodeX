import type { Skill } from "../domain/types.js";

export const builtinSkillCatalog: Skill[] = [
  {
    id: "messages",
    title: "团队消息",
    description: "从团队讨论中获取背景信息、待办和风险",
    accent: "slack",
    connected: false,
    installed: true,
    npmPackage: "@slack/web-api",
    source: "builtin",
    categories: ["communication", "office"],
    keywords: ["slack", "消息", "团队", "聊天", "待办"],
    toolNames: ["discover_or_load_skill", "search_web", "fetch_url"]
  },
  {
    id: "email",
    title: "电子邮件",
    description: "总结邮件、起草回复和跟进请求",
    accent: "mail",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["communication", "office"],
    keywords: ["email", "mail", "邮件", "回复", "跟进"],
    toolNames: ["discover_or_load_skill", "write_file"]
  },
  {
    id: "files",
    title: "文件处理",
    description: "审查报告、研究资料、计划和本地文件",
    accent: "drive",
    connected: false,
    installed: true,
    npmPackage: "@googleapis/drive",
    source: "builtin",
    categories: ["files", "office"],
    keywords: ["文件", "报告", "资料", "drive", "docx", "本地文件"],
    toolNames: ["list_directory", "read_file", "write_file", "search_files", "read_attachment"]
  },
  {
    id: "academic",
    title: "学术研究",
    description: "检索论文资料、整理引用、生成研究综述",
    accent: "research",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["research", "search", "office"],
    keywords: ["学术", "论文", "文献", "引用", "综述", "research", "paper", "citation"],
    toolNames: ["search_web", "fetch_url", "write_file", "run_command"]
  },
  {
    id: "slides",
    title: "PPT 演示",
    description: "生成大纲、讲稿、HTML 演示稿和 PPTX 制作脚本",
    accent: "slides",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["presentation", "office"],
    keywords: ["ppt", "pptx", "slides", "幻灯片", "演示", "讲稿"],
    toolNames: ["inspect_presentation", "write_file", "run_command", "read_attachment"]
  },
  {
    id: "pdf",
    title: "PDF 处理",
    description: "读取、摘要、提取、转换和整理 PDF 内容",
    accent: "pdf",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["pdf", "documents", "office"],
    keywords: ["pdf", "提取", "转换", "阅读", "摘要"],
    toolNames: ["extract_pdf_text", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "search",
    title: "深度搜索",
    description: "联网搜索、读取网页并沉淀可追溯资料",
    accent: "search",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["search", "research"],
    keywords: ["搜索", "网页", "联网", "资料", "latest", "web", "search"],
    toolNames: ["search_web", "fetch_url", "write_file"]
  },
  {
    id: "html",
    title: "HTML 产物",
    description: "生成网页、报告页面、可交互原型和静态 HTML",
    accent: "html",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["html", "frontend", "office"],
    keywords: ["html", "网页", "页面", "前端", "原型", "报告页"],
    toolNames: ["write_file", "read_file", "run_command", "webbridge_command"]
  },
  {
    id: "excel",
    title: "Excel 表格",
    description: "清洗数据、生成 CSV/XLSX、公式和表格分析",
    accent: "excel",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["spreadsheet", "office"],
    keywords: ["excel", "xlsx", "csv", "表格", "数据", "公式", "sheet"],
    toolNames: ["read_spreadsheet", "create_spreadsheet", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "documents",
    title: "文档写作",
    description: "撰写、润色、结构化长文档和工作报告",
    accent: "document",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["documents", "office"],
    keywords: ["docx", "word", "文档", "报告", "润色", "写作"],
    toolNames: ["extract_docx_text", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "webbridge",
    title: "Kimi WebBridge",
    description: "控制真实浏览器、读取网页、截图和跨站操作",
    accent: "webbridge",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["browser", "search", "external"],
    keywords: ["webbridge", "浏览器", "真实浏览器", "网页操作", "browser"],
    toolNames: ["webbridge_status", "webbridge_command"]
  }
];

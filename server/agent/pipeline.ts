import { classifyTask } from "../tools/selection.js";
import type { TaskClassification, TaskClassificationInput } from "../tools/selection.js";
import type { TaskSpec } from "./spec.js";

export type AgentRole = "ResearchAgent" | "CodeAgent" | "ReviewAgent" | "OfficeAgent";

export type PipelineTemplate =
  | "code_review"
  | "research"
  | "research_code_review"
  | "office"
  | "office_research"
  | "full"
  | "fallback";

export type PipelineStageTemplate = {
  name: string;
  parallel: boolean;
  agents: AgentRole[];
};

export type PipelineDefinition = {
  template: PipelineTemplate;
  stages: PipelineStageTemplate[];
};

const officeFormatPattern = /图片|图像|照片|截图|pdf|ppt|幻灯片|演示|excel|表格|数据|csv|xlsx|xls|docx|word|文档|报告|image|photo|screenshot|slides|presentation|spreadsheet|document/i;
const researchIntentPattern = /搜索|联网|查一下|查找|研究|文献|引用|最新|新闻|资讯|web|search|research|paper|citation/i;

const pipelineDefinitions: Record<PipelineTemplate, PipelineDefinition> = {
  code_review: {
    template: "code_review",
    stages: [
      { name: "code", parallel: false, agents: ["CodeAgent"] },
      { name: "review", parallel: false, agents: ["ReviewAgent"] }
    ]
  },
  research: {
    template: "research",
    stages: [{ name: "research", parallel: false, agents: ["ResearchAgent"] }]
  },
  research_code_review: {
    template: "research_code_review",
    stages: [
      { name: "research", parallel: false, agents: ["ResearchAgent"] },
      { name: "code", parallel: false, agents: ["CodeAgent"] },
      { name: "review", parallel: false, agents: ["ReviewAgent"] }
    ]
  },
  office: {
    template: "office",
    stages: [{ name: "office", parallel: false, agents: ["OfficeAgent"] }]
  },
  office_research: {
    template: "office_research",
    stages: [{ name: "office_research", parallel: true, agents: ["OfficeAgent", "ResearchAgent"] }]
  },
  full: {
    template: "full",
    stages: [
      { name: "gather", parallel: true, agents: ["ResearchAgent", "OfficeAgent"] },
      { name: "code", parallel: false, agents: ["CodeAgent"] },
      { name: "review", parallel: false, agents: ["ReviewAgent"] }
    ]
  },
  fallback: {
    template: "fallback",
    stages: [
      { name: "research", parallel: false, agents: ["ResearchAgent"] },
      { name: "code", parallel: false, agents: ["CodeAgent"] },
      { name: "review", parallel: false, agents: ["ReviewAgent"] }
    ]
  }
};

export function getPipelineDefinition(template: PipelineTemplate): PipelineDefinition {
  return pipelineDefinitions[template];
}

export function selectPipelineTemplate(input: TaskClassificationInput | TaskClassification | TaskSpec): PipelineTemplate {
  if (isTaskSpec(input)) return selectPipelineTemplateFromSpec(input);
  const classification = isTaskClassification(input) ? input : classifyTask(input);
  const needsCode = classification.needsClaudeCode;
  const needsResearch = classification.needsWeb || researchIntentPattern.test(classification.selectorText);
  const needsOffice = hasOfficeAttachment(classification) || hasOfficeIntent(classification);

  if (needsCode && needsResearch && needsOffice) return "full";
  if (needsCode && needsResearch) return "research_code_review";
  if (needsCode) return "code_review";
  if (needsOffice && needsResearch) return "office_research";
  if (needsOffice) return "office";
  if (needsResearch) return "research";
  return "fallback";
}

export function selectPipelineDefinition(input: TaskClassificationInput | TaskClassification | TaskSpec): PipelineDefinition {
  return getPipelineDefinition(selectPipelineTemplate(input));
}

export function selectPipelineTemplateFromSpec(spec: TaskSpec): PipelineTemplate {
  const domains = new Set(spec.domains);
  const needsCode = domains.has("code") || spec.requiredSkills.includes("code");
  const needsResearch = domains.has("research") || spec.requiredSkills.includes("research");
  const needsOffice = [
    "office",
    "presentation",
    "spreadsheet",
    "document",
    "pdf",
    "image"
  ].some((domain) => domains.has(domain as TaskSpec["domains"][number]));

  if (needsCode && needsResearch && needsOffice) return "full";
  if (needsCode && needsResearch) return "research_code_review";
  if (needsCode) return "code_review";
  if (needsOffice && needsResearch) return "office_research";
  if (needsOffice) return "office";
  if (needsResearch) return "research";
  return spec.complexity === "simple" ? "research" : "fallback";
}

function isTaskClassification(input: TaskClassificationInput | TaskClassification): input is TaskClassification {
  return "selectorText" in input && "needsClaudeCode" in input;
}

function isTaskSpec(input: TaskClassificationInput | TaskClassification | TaskSpec): input is TaskSpec {
  return "acceptanceCriteria" in input && "requiredSkills" in input;
}

function hasOfficeAttachment(classification: TaskClassification) {
  return (
    classification.hasImages ||
    classification.hasPdfAttachment ||
    classification.hasSpreadsheetAttachment ||
    classification.hasDocumentAttachment ||
    classification.hasPresentationAttachment
  );
}

function hasOfficeIntent(classification: TaskClassification) {
  return (
    classification.needsOffice ||
    classification.needsPdf ||
    classification.needsSpreadsheet ||
    classification.needsDocuments ||
    classification.needsPresentation ||
    officeFormatPattern.test(classification.selectorText) ||
    classification.activeCategories.has("office") ||
    classification.activeCategories.has("pdf") ||
    classification.activeCategories.has("spreadsheet") ||
    classification.activeCategories.has("documents") ||
    classification.activeCategories.has("presentation")
  );
}

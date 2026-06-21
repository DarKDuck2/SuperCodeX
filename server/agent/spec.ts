import { classifyTask } from "../tools/selection.js";
import type { TaskClassification, TaskClassificationInput } from "../tools/selection.js";
import type { DeliveryMode } from "../domain/types.js";

export type TaskComplexity = "simple" | "medium" | "complex";

export type TaskDomain =
  | "code"
  | "research"
  | "office"
  | "presentation"
  | "spreadsheet"
  | "document"
  | "pdf"
  | "browser"
  | "image";

export type TaskSpec = {
  id: string;
  complexity: TaskComplexity;
  domains: TaskDomain[];
  goal: string;
  deliverables: string[];
  constraints: string[];
  requiredSkills: string[];
  acceptanceCriteria: string[];
  verificationPlan: string[];
  risks: string[];
  maxIterations: number;
};

export type SkillContextBundle = {
  skillId: string;
  title: string;
  context: string[];
  spec: string[];
  acceptance: string[];
};

export type ReviewVerdict = {
  passed: boolean;
  score: number;
  failedCriteria: string[];
  requiredFixes: string[];
  risks: string[];
  summary: string;
};

const deliveryPatterns = {
  artifact: /生成|创建|制作|撰写|输出|交付|实现|修复|重构|报告|文档|PPT|幻灯片|表格|dashboard|app|页面|代码|create|build|write|implement|fix|refactor|deliver|report|deck/i,
  strictness: /验收|标准|规范|高质量|完整|上线|生产|正式|重要|复杂|反复|迭代|检查|verify|validate|production|important|complex/i
};

const domainSkillMap: Record<TaskDomain, string[]> = {
  code: ["code"],
  research: ["research"],
  office: ["office"],
  presentation: ["presentation", "office"],
  spreadsheet: ["spreadsheet", "office"],
  document: ["document", "office"],
  pdf: ["pdf", "document", "office"],
  browser: ["browser"],
  image: ["image", "office"]
};

const skillBundles: Record<string, SkillContextBundle> = {
  code: {
    skillId: "code",
    title: "Code Delivery",
    context: [
      "Prefer small, reviewable changes that fit the existing codebase.",
      "Read nearby code and tests before editing.",
      "Do not discard unrelated local changes."
    ],
    spec: [
      "Implementation work must include changed files, rationale, and verification.",
      "Use existing abstractions and project scripts before introducing new dependencies.",
      "Keep behavior changes scoped to the user's requested outcome."
    ],
    acceptance: [
      "Relevant tests or builds pass, or failures are clearly explained.",
      "The final answer names changed files and remaining risks.",
      "No unrelated refactors or destructive operations are introduced."
    ]
  },
  research: {
    skillId: "research",
    title: "Research Delivery",
    context: [
      "Gather evidence before synthesis when claims may be time-sensitive or externally verifiable.",
      "Prefer primary sources, official docs, papers, standards, or reputable directly relevant sources."
    ],
    spec: [
      "Separate findings from assumptions.",
      "Include source attribution when web sources are used.",
      "Call out confidence and gaps."
    ],
    acceptance: [
      "Key claims are supported by sources or explicitly marked as inference.",
      "The result includes concise findings, implications, and gaps.",
      "Dates are concrete when recency matters."
    ]
  },
  office: {
    skillId: "office",
    title: "Office Artifact Delivery",
    context: [
      "Treat documents, spreadsheets, presentations, and images as deliverables that need inspection, not just text generation.",
      "Prefer structured parsers and artifact-producing tools over ad hoc text handling."
    ],
    spec: [
      "Deliverables should be named, saved, and summarized.",
      "Formatting, readability, and data fidelity matter.",
      "Generated files should live in the configured output directory unless the user specified a path."
    ],
    acceptance: [
      "The final answer links or names generated artifacts.",
      "Important formatting or data limitations are disclosed.",
      "The output is ready for the user's next step."
    ]
  },
  presentation: {
    skillId: "presentation",
    title: "Presentation Delivery",
    context: [
      "A deck needs a clear storyline, concise slide intent, and consistent visual treatment.",
      "Use evidence and captions where data or claims appear."
    ],
    spec: [
      "Include a logical slide structure: context, analysis, insight, recommendation or next steps.",
      "Avoid slide clutter; each slide should have one primary job.",
      "Ensure generated deck artifacts are inspectable."
    ],
    acceptance: [
      "The deck structure matches the user's audience and objective.",
      "Claims and data are traceable where possible.",
      "The final result identifies any visual or source limitations."
    ]
  },
  spreadsheet: {
    skillId: "spreadsheet",
    title: "Spreadsheet Delivery",
    context: [
      "Spreadsheet work should preserve headers, data types, and formulas where relevant.",
      "Summaries should include dimensions, assumptions, and anomalies."
    ],
    spec: [
      "Inspect sheet names, columns, sample rows, and obvious data quality issues.",
      "For generated workbooks, use structured workbook writers.",
      "Explain calculations or transformations."
    ],
    acceptance: [
      "Important columns and row counts are considered.",
      "Generated tables are usable and named clearly.",
      "Known data quality issues are listed."
    ]
  },
  document: {
    skillId: "document",
    title: "Document Delivery",
    context: [
      "Document tasks need structure, tone, completeness, and factual consistency.",
      "Preserve user intent and mark uncertain content."
    ],
    spec: [
      "Use headings and concise sections for long-form deliverables.",
      "Keep revisions aligned to the target audience.",
      "Mention source or formatting limitations."
    ],
    acceptance: [
      "The document has a clear structure and purpose.",
      "Tone and level of detail fit the user's request.",
      "Open questions and assumptions are explicit."
    ]
  },
  pdf: {
    skillId: "pdf",
    title: "PDF Delivery",
    context: [
      "PDFs may be text-based or scanned; extraction quality must be checked.",
      "Page references matter when reviewing or summarizing."
    ],
    spec: [
      "Extract readable text with page awareness when possible.",
      "State if the PDF appears scanned or incomplete.",
      "Summaries should preserve key claims, numbers, and caveats."
    ],
    acceptance: [
      "The result reflects available PDF content accurately.",
      "Extraction limitations are disclosed.",
      "Important page or section references are included when available."
    ]
  },
  browser: {
    skillId: "browser",
    title: "Browser Task Delivery",
    context: [
      "Browser automation should use low-risk actions and report observable state.",
      "Avoid exposing raw DOM or large HTML dumps."
    ],
    spec: [
      "Navigate, inspect, and summarize only what is needed.",
      "Record actions taken and any blockers.",
      "Prefer stable selectors or page-visible evidence."
    ],
    acceptance: [
      "The requested page/task state is verified.",
      "Any login, permission, or page-state blocker is clear.",
      "The final answer describes completed browser actions."
    ]
  },
  image: {
    skillId: "image",
    title: "Image Delivery",
    context: [
      "Image tasks should preserve source intent and clearly name transformations.",
      "Generated or transformed images need artifact paths."
    ],
    spec: [
      "Use image tools for crop, resize, rotate, format conversion, and enhancements.",
      "Avoid overwriting source images unless explicitly requested.",
      "Mention dimensions or format changes when relevant."
    ],
    acceptance: [
      "The transformed image artifact is saved.",
      "The final answer states what changed.",
      "Source limitations or destructive edits are disclosed."
    ]
  }
};

export function generateTaskSpec(
  input: TaskClassificationInput & { id: (prefix: string) => string; deliveryMode?: DeliveryMode }
): TaskSpec {
  const classification = classifyTask(input);
  const domains = inferDomains(classification);
  const requiredSkills = unique(domains.flatMap((domain) => domainSkillMap[domain] || [domain]));
  const baseComplexity = inferComplexity(classification, domains);
  const complexity = applyDeliveryModeComplexity(baseComplexity, input.deliveryMode);
  const goal = input.prompt.trim() || "Complete the user's task.";

  return {
    id: input.id("spec"),
    complexity,
    domains,
    goal,
    deliverables: inferDeliverables(classification, domains, goal),
    constraints: inferConstraints(classification, domains),
    requiredSkills,
    acceptanceCriteria: inferAcceptanceCriteria(domains, complexity),
    verificationPlan: inferVerificationPlan(domains, complexity),
    risks: inferRisks(classification, domains),
    maxIterations: maxIterationsForDeliveryMode(complexity, input.deliveryMode)
  };
}

export function normalizeDeliveryMode(value: unknown): DeliveryMode {
  return value === "fast" || value === "strict" || value === "standard" ? value : "standard";
}

export function getSkillContextBundles(requiredSkills: string[]) {
  return unique(requiredSkills)
    .map((skillId) => skillBundles[skillId])
    .filter((bundle): bundle is SkillContextBundle => Boolean(bundle));
}

export function formatTaskSpec(spec: TaskSpec) {
  return [
    `TaskSpec ${spec.id}`,
    `Complexity: ${spec.complexity}`,
    `Domains: ${spec.domains.join(", ") || "general"}`,
    `Goal: ${spec.goal}`,
    list("Deliverables", spec.deliverables),
    list("Constraints", spec.constraints),
    list("Required skills", spec.requiredSkills),
    list("Acceptance criteria", spec.acceptanceCriteria),
    list("Verification plan", spec.verificationPlan),
    list("Risks", spec.risks),
    `Max repair iterations: ${spec.maxIterations}`
  ].filter(Boolean).join("\n");
}

export function formatSkillContextBundles(bundles: SkillContextBundle[]) {
  if (!bundles.length) return "No specialized skill context was loaded.";
  return [
    "Loaded specialized skill/spec context:",
    ...bundles.map((bundle) =>
      [
        `## ${bundle.title} (${bundle.skillId})`,
        list("Context", bundle.context),
        list("Spec", bundle.spec),
        list("Acceptance", bundle.acceptance)
      ].join("\n")
    )
  ].join("\n\n");
}

export function buildReviewPrompt(spec: TaskSpec, subAgentHandoffs: string[], iteration: number) {
  return [
    "Review the delivery strictly against the TaskSpec.",
    "Return JSON only with this shape:",
    '{"passed": boolean, "score": number, "failedCriteria": string[], "requiredFixes": string[], "risks": string[], "summary": string}',
    "",
    formatTaskSpec(spec),
    "",
    `Review iteration: ${iteration}`,
    "Sub-agent handoffs:",
    subAgentHandoffs.join("\n\n") || "(No handoffs.)"
  ].join("\n");
}

export function parseReviewVerdict(value: string): ReviewVerdict {
  const parsed = parseJsonObject(value);
  const failedCriteria = stringArray(parsed.failedCriteria);
  const requiredFixes = stringArray(parsed.requiredFixes);
  const risks = stringArray(parsed.risks);
  const score = clampScore(Number(parsed.score));
  const passed = typeof parsed.passed === "boolean"
    ? parsed.passed
    : score >= 0.8 && failedCriteria.length === 0 && requiredFixes.length === 0;
  return {
    passed,
    score,
    failedCriteria,
    requiredFixes,
    risks,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : fallbackReviewSummary(passed, score, failedCriteria)
  };
}

export function fallbackReviewVerdict(summary: string): ReviewVerdict {
  const failed = /failed|error|aborted|未通过|失败|错误/i.test(summary);
  return {
    passed: !failed,
    score: failed ? 0.45 : 0.8,
    failedCriteria: failed ? ["Review result reported a failure."] : [],
    requiredFixes: failed ? ["Inspect the failed sub-agent result and repair the delivery."] : [],
    risks: [],
    summary: summary.trim() || (failed ? "Review found issues." : "Review passed by fallback heuristic.")
  };
}

function inferDomains(classification: TaskClassification): TaskDomain[] {
  const domains: TaskDomain[] = [];
  if (classification.needsClaudeCode || classification.needsCode) domains.push("code");
  if (classification.needsWeb) domains.push("research");
  if (classification.needsBrowser) domains.push("browser");
  if (classification.needsImages || classification.hasImages) domains.push("image");
  if (classification.needsPresentation || classification.hasPresentationAttachment) domains.push("presentation");
  if (classification.needsSpreadsheet || classification.hasSpreadsheetAttachment) domains.push("spreadsheet");
  if (classification.needsDocuments || classification.hasDocumentAttachment) domains.push("document");
  if (classification.needsPdf || classification.hasPdfAttachment) domains.push("pdf");
  if (classification.needsOffice || classification.hasAttachments) domains.push("office");
  return unique(domains);
}

function inferComplexity(classification: TaskClassification, domains: TaskDomain[]): TaskComplexity {
  const text = classification.selectorText;
  const domainWeight = domains.filter((domain) => domain !== "office").length;
  if (
    deliveryPatterns.strictness.test(text) ||
    domainWeight >= 3 ||
    (classification.needsClaudeCode && (classification.needsWeb || classification.needsOfficeTools || classification.hasAttachments)) ||
    (classification.needsWeb && classification.needsOfficeTools && deliveryPatterns.artifact.test(text))
  ) {
    return "complex";
  }
  if (domainWeight >= 2 || classification.needsClaudeCode || classification.needsWeb || classification.needsOfficeTools || classification.hasAttachments) {
    return "medium";
  }
  return "simple";
}

function applyDeliveryModeComplexity(complexity: TaskComplexity, deliveryMode: DeliveryMode = "standard"): TaskComplexity {
  if (deliveryMode === "strict") return complexity === "simple" ? "medium" : "complex";
  if (deliveryMode === "fast") return complexity === "complex" ? "medium" : complexity;
  return complexity;
}

function maxIterationsForDeliveryMode(complexity: TaskComplexity, deliveryMode: DeliveryMode = "standard") {
  if (deliveryMode === "fast") return 0;
  if (deliveryMode === "strict") return complexity === "simple" ? 1 : 2;
  return complexity === "complex" ? 2 : complexity === "medium" ? 1 : 0;
}

function inferDeliverables(classification: TaskClassification, domains: TaskDomain[], goal: string) {
  const deliverables = ["A concise final answer that addresses the user's goal."];
  if (domains.includes("code")) deliverables.push("Implemented code changes or a clear code inspection report.");
  if (domains.includes("research")) deliverables.push("Evidence-backed research summary with sources or stated gaps.");
  if (domains.includes("presentation")) deliverables.push("Presentation structure or generated deck artifact.");
  if (domains.includes("spreadsheet")) deliverables.push("Spreadsheet analysis or generated workbook artifact.");
  if (domains.includes("document") || domains.includes("pdf")) deliverables.push("Document/PDF summary, review, or generated document artifact.");
  if (domains.includes("browser")) deliverables.push("Browser task result with observed page state.");
  if (domains.includes("image")) deliverables.push("Image processing result or generated image artifact.");
  if (deliveryPatterns.artifact.test(goal) && deliverables.length === 1) deliverables.push("Named artifact or implementation output.");
  if (classification.hasAttachments) deliverables.push("Attachment-aware analysis that names any relevant files.");
  return unique(deliverables);
}

function inferConstraints(classification: TaskClassification, domains: TaskDomain[]) {
  const constraints = [
    "Use the active workspace and generated files directory rules.",
    "Preserve unrelated user changes and avoid destructive operations.",
    "Keep the final answer in the user's language."
  ];
  if (domains.includes("research")) constraints.push("Use sources for externally verifiable or time-sensitive claims.");
  if (domains.includes("code")) constraints.push("Prefer existing project patterns and run focused verification when possible.");
  if (classification.hasAttachments) constraints.push("Use uploaded attachments as primary context when relevant.");
  return constraints;
}

function inferAcceptanceCriteria(domains: TaskDomain[], complexity: TaskComplexity) {
  const criteria = [
    "The final result directly satisfies the user's stated goal.",
    "All promised deliverables are present or explicitly marked as blocked.",
    "Important assumptions, limitations, and remaining risks are disclosed."
  ];
  if (domains.includes("code")) criteria.push("Code changes are verified with relevant tests/builds or a clear explanation of why verification was not run.");
  if (domains.includes("research")) criteria.push("Research claims include source attribution or are marked as inference.");
  if (domains.some((domain) => ["office", "presentation", "spreadsheet", "document", "pdf", "image"].includes(domain))) {
    criteria.push("Generated or inspected artifacts are named and checked for obvious formatting/data issues.");
  }
  if (complexity === "complex") criteria.push("A review pass has checked the result against these criteria.");
  return unique(criteria);
}

function inferVerificationPlan(domains: TaskDomain[], complexity: TaskComplexity) {
  const plan = ["Review the final output against the acceptance criteria."];
  if (domains.includes("code")) plan.push("Run the project's relevant tests or build command when feasible.");
  if (domains.includes("research")) plan.push("Check source quality, dates, and claim-source alignment.");
  if (domains.includes("spreadsheet")) plan.push("Inspect workbook dimensions, columns, and sample rows.");
  if (domains.includes("presentation")) plan.push("Check deck structure, slide intent, and artifact availability.");
  if (complexity !== "simple") plan.push("Run a dedicated ReviewAgent pass before final delivery.");
  return unique(plan);
}

function inferRisks(classification: TaskClassification, domains: TaskDomain[]) {
  const risks = [];
  if (domains.includes("research")) risks.push("External information may change or require source verification.");
  if (domains.includes("code")) risks.push("Tests may be incomplete or unavailable in the local workspace.");
  if (classification.hasAttachments) risks.push("Attachment parsing may omit scanned, embedded, or visually encoded content.");
  if (!risks.length) risks.push("The request may need clarification if hidden requirements emerge.");
  return risks;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function fallbackReviewSummary(passed: boolean, score: number, failedCriteria: string[]) {
  if (passed) return `Review passed with score ${score.toFixed(2)}.`;
  return `Review failed with score ${score.toFixed(2)}${failedCriteria.length ? `: ${failedCriteria.join("; ")}` : "."}`;
}

function list(title: string, items: string[]) {
  return items.length ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}` : "";
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

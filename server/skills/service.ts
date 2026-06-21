import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeLocalPath } from "../core/paths.js";
import { normalizeWhitespace } from "../core/text.js";
import { builtinSkillCatalog } from "./catalog.js";
import type { Skill } from "../domain/types.js";

type CreateSkillServiceDependencies = {
  skills: Map<string, Skill>;
  id: (prefix: string) => string;
  now: () => string;
};

export function createSkillService(deps: CreateSkillServiceDependencies) {
  const { skills, id, now } = deps;

  function searchSkillCatalog(query: string) {
    const normalizedQuery = normalizeWhitespace(query).toLowerCase();
    const catalog = mergeSkillCatalog();
    if (!normalizedQuery) return catalog.map(publicSkillSummary);
    return catalog
      .map((skill) => ({ skill, score: scoreSkill(skill, normalizedQuery) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.title.localeCompare(right.skill.title))
      .map((entry) => publicSkillSummary(entry.skill));
  }
  
  function mergeSkillCatalog() {
    const merged = new Map<string, Skill>();
    for (const skill of builtinSkillCatalog) merged.set(skill.id, normalizeSkill(skill));
    for (const skill of skills.values()) {
      const base = merged.get(skill.id);
      merged.set(skill.id, normalizeSkill({ ...base, ...skill }));
    }
    return [...merged.values()];
  }
  
  function scoreSkill(skill: Skill, query: string) {
    const haystack = [
      skill.id,
      skill.title,
      skill.description,
      ...(skill.categories || []),
      ...(skill.keywords || []),
      ...(skill.toolNames || [])
    ].join(" ").toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let score = 0;
    for (const term of terms) {
      if (skill.id.toLowerCase() === term) score += 8;
      if (skill.title.toLowerCase().includes(term)) score += 5;
      if (haystack.includes(term)) score += 2;
    }
    if (haystack.includes(query)) score += 6;
    return score;
  }
  
  function loadSkillById(skillId: string, source: Skill["source"] = "builtin") {
    const existing = skills.get(skillId);
    const builtin = builtinSkillCatalog.find((skill) => skill.id === skillId);
    const skill = existing || builtin;
    if (!skill) return undefined;
    const normalized = normalizeSkill({
      ...builtin,
      ...skill,
      source: skill.source || source,
      installed: true
    });
    skills.set(normalized.id, normalized);
    return normalized;
  }
  
  async function loadExternalSkill(input: Record<string, unknown>) {
    const manifestPath = String(input.path || input.manifestPath || "").trim();
    let manifest = input;
    let instructions = typeof input.instructions === "string" ? input.instructions : "";
  
    if (manifestPath) {
      const targetPath = normalizeLocalPath(manifestPath);
      const stat = await fs.stat(targetPath);
      const filePath = stat.isDirectory() ? path.join(targetPath, "SKILL.md") : targetPath;
      const content = await fs.readFile(filePath, "utf-8");
      manifest = parseSkillMarkdown(content, filePath);
      instructions ||= content.slice(0, 4000);
    }
  
    const idValue = String(manifest.id || manifest.name || manifest.title || "").trim();
    if (!idValue) throw new Error("skill id or title is required");
    const skillId = slugifySkillId(idValue);
    const skill: Skill = normalizeSkill({
      id: skillId,
      title: String(manifest.title || manifest.name || idValue),
      description: String(manifest.description || "用户加载的自定义能力"),
      accent: String(manifest.accent || "custom"),
      connected: input.connect !== false,
      installed: true,
      source: "user",
      categories: toStringList(manifest.categories),
      keywords: toStringList(manifest.keywords),
      toolNames: toStringList(manifest.toolNames || manifest.tools),
      instructions,
      manifestPath: manifestPath || undefined,
      lastLoadedAt: now()
    });
    skills.set(skill.id, skill);
    return skill;
  }
  
  function parseSkillMarkdown(content: string, filePath: string) {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    const data: Record<string, unknown> = {};
    if (frontmatter) {
      for (const line of frontmatter[1].split("\n")) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) continue;
        const [, key, value] = match;
        data[key] = value.includes(",") ? value.split(",").map((item) => item.trim()).filter(Boolean) : value.trim();
      }
    }
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(path.dirname(filePath));
    const description = content
      .replace(/^---\n[\s\S]*?\n---/, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    return {
      ...data,
      title: data.title || title,
      description: data.description || description || "用户加载的 Markdown skill",
      instructions: content.slice(0, 4000)
    };
  }
  
  function normalizeSkill(skill: Skill): Skill {
    return {
      ...skill,
      source: skill.source || "builtin",
      categories: uniqueStrings(skill.categories || []),
      keywords: uniqueStrings(skill.keywords || []),
      toolNames: uniqueStrings(skill.toolNames || []),
      connected: Boolean(skill.connected),
      installed: skill.installed !== false
    };
  }
  
  function publicSkillSummary(skill: Skill) {
    return {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      accent: skill.accent,
      connected: skill.connected,
      installed: skill.installed,
      source: skill.source,
      categories: skill.categories || [],
      keywords: skill.keywords || [],
      toolNames: skill.toolNames || []
    };
  }
  
  function getActiveSkillSelection() {
    const active = [...skills.values()].filter((skill) => skill.connected);
    return {
      activeSkillIds: active.map((skill) => skill.id),
      activeSkillCategories: uniqueStrings(active.flatMap((skill) => skill.categories || [])),
      activeSkillKeywords: uniqueStrings(active.flatMap((skill) => skill.keywords || []))
    };
  }
  
  function formatSkillContext() {
    const active = [...skills.values()].filter((skill) => skill.connected);
    const catalog = mergeSkillCatalog();
    return [
      active.length
        ? `Loaded skills: ${active.map((skill) => `${skill.id} (${skill.title})`).join(", ")}.`
        : "No optional skills are currently loaded.",
      `Skill catalog: ${catalog
        .map((skill) => `${skill.id}=${skill.title} [${(skill.categories || []).join("/")}]`)
        .join("; ")}.`,
      "If a task would benefit from a catalog skill that is not loaded, call discover_or_load_skill first, then continue the task."
    ].join(" ");
  }
  
  function toStringList(value: unknown) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
    return [];
  }
  
  function uniqueStrings(values: string[]) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
  
  function slugifySkillId(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || id("skill");
  }

  return {
    searchSkillCatalog,
    loadSkillById,
    loadExternalSkill,
    normalizeSkill,
    publicSkillSummary,
    getActiveSkillSelection,
    formatSkillContext
  };
}

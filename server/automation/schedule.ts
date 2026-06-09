import { normalizeWhitespace, titleFromPrompt } from "../core/text.js";

export function parseAutomationInput(input: {
  title?: string;
  schedule?: string;
  prompt?: string;
  instruction?: string;
}) {
  const instruction = normalizeWhitespace(input.instruction || "");
  const schedule = normalizeScheduleText(input.schedule || extractScheduleText(instruction));
  const prompt = normalizeWhitespace(
    input.prompt ||
      extractAutomationPrompt(instruction, schedule) ||
      instruction ||
      input.title ||
      "执行这个定时任务。"
  );
  return {
    title: normalizeWhitespace(input.title || titleFromPrompt(prompt || instruction || "新自动化")),
    schedule: schedule || "手动触发",
    prompt
  };
}

export function normalizeScheduleText(value: string) {
  const text = normalizeWhitespace(value);
  if (!text) return "";
  const interval = text.match(/每\s*(\d+)\s*(?:h|H|小时|个小时)/);
  if (interval) return `每${Math.max(1, Number(interval[1]))}小时`;
  if (/下班前|下班之前/.test(text)) return "每天 17:30";
  const time = extractTimeOfDay(text);
  if (time) return `每天 ${time}`;
  if (/手动/.test(text)) return "手动触发";
  return text;
}

export function computeNextRunAt(schedule: string, from = new Date()) {
  const normalized = normalizeScheduleText(schedule);
  if (!normalized || normalized === "手动触发") return undefined;
  const interval = normalized.match(/^每(\d+)小时$/);
  if (interval) {
    return new Date(from.getTime() + Math.max(1, Number(interval[1])) * 60 * 60 * 1000).toISOString();
  }
  const daily = normalized.match(/^每天\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const next = new Date(from);
    next.setHours(Number(daily[1]), Number(daily[2]), 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return undefined;
}

function extractScheduleText(instruction: string) {
  const interval = instruction.match(/每\s*(\d+)\s*(?:h|H|小时|个小时)/);
  if (interval) return `每${interval[1]}小时`;
  if (/每\s*(?:天|日)|每天|每日/.test(instruction)) {
    const time = extractTimeOfDay(instruction);
    if (time) return `每天 ${time}`;
  }
  if (/下班前|下班之前/.test(instruction)) return "每天 17:30";
  const time = extractTimeOfDay(instruction);
  return time ? `每天 ${time}` : "";
}

function extractAutomationPrompt(instruction: string, schedule: string) {
  if (!instruction) return "";
  let prompt = instruction;
  prompt = prompt.replace(/每\s*(\d+)\s*(?:h|H|小时|个小时)/g, "");
  prompt = prompt.replace(/每天|每日|每日上午|每天上午|每天早上|每天中午|每天下午|每天晚上|每天早晨|每晚/g, "");
  prompt = prompt.replace(/凌晨|早上|早晨|上午|中午|下午|晚上|晚间|夜里/g, "");
  prompt = prompt.replace(/下班前|下班之前/g, "");
  if (schedule) {
    const time = schedule.match(/\d{1,2}:\d{2}/)?.[0];
    if (time) {
      const [hour, minute] = time.split(":").map(Number);
      prompt = prompt
        .replace(new RegExp(`${hour}\\s*[:：]\\s*${minute.toString().padStart(2, "0")}`), "")
        .replace(new RegExp(`${hour}\\s*点\\s*${minute ? `${minute}\\s*分?` : ""}`), "");
    }
  }
  return normalizeWhitespace(prompt.replace(/^(提醒|返回|推送|生成|完成)?/, "$1").replace(/[，,。；;]\s*$/, "")) || instruction;
}

function extractTimeOfDay(text: string) {
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (colon) return formatTime(Number(colon[1]), Number(colon[2]));
  const chinese = text.match(/(?:(凌晨|早上|早晨|上午|中午|下午|晚上|晚间|夜里)\s*)?(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/);
  if (!chinese) return "";
  let hour = Number(chinese[2]);
  const minute = Number(chinese[3] || 0);
  const period = chinese[1] || "";
  if ((period === "下午" || period === "晚上" || period === "晚间" || period === "夜里") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  return formatTime(hour, minute);
}

function formatTime(hour: number, minute: number) {
  const safeHour = Math.max(0, Math.min(23, hour));
  const safeMinute = Math.max(0, Math.min(59, minute));
  return `${safeHour.toString().padStart(2, "0")}:${safeMinute.toString().padStart(2, "0")}`;
}

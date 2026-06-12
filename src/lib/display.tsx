import { FileCode, FileText, Image as ImageIcon, Presentation, Table2 } from "lucide-react";
import type {
  Artifact,
  Automation,
  MessageDisplayItem,
  ProjectTreeNode,
  StoredMessage,
  ToolCall,
  ToolMessage,
  ToolRound
} from "../types";

export function titleFromPrompt(prompt: string) {
  return prompt.length > 22 ? `${prompt.slice(0, 22)}...` : prompt;
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatAutomationStatus(automation: Automation) {
  if (automation.lastStatus === "running") return "正在执行";
  if (automation.lastStatus === "success") {
    return `上次成功 ${automation.lastRunAt ? formatDateTime(automation.lastRunAt) : ""}`;
  }
  if (automation.lastStatus === "error") {
    return `上次失败：${automation.lastError || "未知错误"}`;
  }
  return "尚未执行";
}

export function renderRichText(content: string) {
  const blocks = content
    .replace(/```[\w-]*\n?/g, "\n")
    .replace(/```/g, "\n")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "\n")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
    if (heading) return <h3 key={index}>{renderInlineText(heading[1])}</h3>;

    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return (
        <ul key={index}>
          {lines.map((line, itemIndex) => (
            <li key={itemIndex}>{renderInlineText(line.replace(/^[-*]\s+/, ""))}</li>
          ))}
        </ul>
      );
    }

    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      return (
        <ol key={index}>
          {lines.map((line, itemIndex) => (
            <li key={itemIndex}>{renderInlineText(line.replace(/^\d+\.\s+/, ""))}</li>
          ))}
        </ol>
      );
    }

    if (lines.length > 1 && lines.every((line) => line.startsWith("|") && line.endsWith("|"))) {
      return (
        <div className="softTable" key={index}>
          {lines.map((line, rowIndex) => (
            <div className="softTableRow" key={rowIndex}>
              {line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim())
                .filter(Boolean)
                .map((cell, cellIndex) => (
                  <span key={cellIndex}>{renderInlineText(cell)}</span>
                ))}
            </div>
          ))}
        </div>
      );
    }

    return <p key={index}>{renderInlineText(lines.join("\n"))}</p>;
  });
}

function renderInlineText(value: string) {
  const cleaned = value.replace(/^>\s?/, "").replace(/`([^`]+)`/g, "$1");
  const parts = cleaned.split(/(\*\*[^*]+\*\*|__[^_]+__)/g).filter(Boolean);
  return parts.map((part, index) => {
    const strong = part.match(/^(?:\*\*|__)(.+)(?:\*\*|__)$/);
    return strong ? <strong key={index}>{strong[1]}</strong> : <span key={index}>{part.replace(/\*([^*\n]+)\*/g, "$1")}</span>;
  });
}

export function buildMessageDisplayItems(messages: StoredMessage[]): MessageDisplayItem[] {
  const items: MessageDisplayItem[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "tool") {
      items.push({ type: "toolRound", id: `tool-${message.id}`, rounds: [{ toolResults: [message] }] });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const rounds: ToolRound[] = [];
      let nextIndex = index;
      const itemId = message.id;

      while (nextIndex < messages.length) {
        const assistant = messages[nextIndex];
        if (assistant.role !== "assistant" || !assistant.tool_calls?.length) break;

        const toolResults: ToolMessage[] = [];
        nextIndex++;
        while (nextIndex < messages.length && messages[nextIndex].role === "tool") {
          toolResults.push(messages[nextIndex] as ToolMessage);
          nextIndex++;
        }

        rounds.push({ assistant, toolResults });
      }

      items.push({ type: "toolRound", id: itemId, rounds });
      index = nextIndex - 1;
      continue;
    }

    items.push({ type: "message", message });
  }
  return items;
}

export function getToolRoundNarrative(round: ToolRound, roundIndex: number) {
  const toolCalls = round.assistant?.tool_calls || [];
  if (toolCalls.length === 0 && round.toolResults.length > 0) {
    return round.toolResults.map(getToolSummary).join("，");
  }

  const actions = toolCalls.map(getToolCallSummary);
  if (actions.length === 0) return `正在推进第 ${roundIndex + 1} 步。`;
  const uniqueActions = [...new Set(actions)];
  if (uniqueActions.length === 1) return uniqueActions[0];
  return `正在处理：${uniqueActions.join("，")}。`;
}

export function getToolSequenceSummary(toolCalls: ToolCall[], toolResults: ToolMessage[]) {
  const names = [...toolCalls.map((toolCall) => toolCall.function.name), ...toolResults.map((result) => result.toolName)]
    .filter((name): name is string => Boolean(name));
  const toolCount = new Set(names).size || toolCalls.length || toolResults.length;
  const callCount = toolCalls.length || toolResults.length;
  const commandCount =
    toolCalls.filter((toolCall) => toolCall.function.name === "run_command").length ||
    toolResults.filter((result) => result.toolName === "run_command").length;
  const parts = [`工具详情：${callCount} 次调用`];
  if (toolCount > 1) parts.push(`${toolCount} 类工具`);
  if (commandCount > 0) parts.push(`运行 ${commandCount} 个命令`);
  return parts.join("，");
}

export function formatToolRequest(toolCall: ToolCall) {
  try {
    return JSON.stringify(JSON.parse(toolCall.function.arguments || "{}"), null, 2);
  } catch {
    return toolCall.function.arguments || "{}";
  }
}

export function formatToolResponse(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function cleanAssistantContent(content: string) {
  return content
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, "")
    .replace(/<\|\|DSML\|\|tool_calls>[\s\S]*?<\/\|\|DSML\|\|tool_calls>/g, "")
    .trim();
}

export function extractArtifacts(messages: StoredMessage[], projectId?: string): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  for (const message of messages) {
    if (message.role !== "tool") {
      message.attachments?.forEach((attachment) => {
        artifacts.set(attachment.id, {
          id: attachment.id,
          title: attachment.originalName,
          description: attachment.kind === "image" ? "图片附件" : "文件附件",
          href: attachment.url,
          kind: attachment.kind === "image" ? "image" : "file"
        });
      });
      continue;
    }

    const urlMatch = message.content.match(/URL:\s*(\/api\/attachments\/[^\s]+)/);
    if (urlMatch) {
      artifacts.set(`${message.id}-image`, {
        id: `${message.id}-image`,
        title: "处理后的图片",
        description: message.toolName || "图片产物",
        href: urlMatch[1],
        kind: "image"
      });
    }

    const fileMatches = [...message.content.matchAll(/^(?:File written|Updated|Generated file):\s*([^\n(]+)/gm)];
    for (const [index, fileMatch] of fileMatches.entries()) {
      const filePath = fileMatch[1].trim();
      if (!filePath) continue;
      artifacts.set(`${message.id}-file-${index}-${filePath}`, {
        id: `${message.id}-file-${index}`,
        title: filePath,
        description: getArtifactDescription(filePath),
        href: projectId ? `/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}` : "#",
        kind: getArtifactKind(filePath),
        filePath
      });
    }
  }
  return [...artifacts.values()].slice(-6);
}

export function renderArtifactIcon(artifact: Artifact) {
  if (artifact.kind === "image") return <ImageIcon size={17} />;
  if (artifact.kind === "presentation") return <Presentation size={17} />;
  if (artifact.kind === "code") return <FileCode size={17} />;
  if (artifact.kind === "table") return <Table2 size={17} />;
  return <FileText size={17} />;
}

export function removeMessage(messages: StoredMessage[], id: string) {
  return messages.filter((message) => message.id !== id);
}

export function upsertStreamMessage(messages: StoredMessage[], nextMessage: StoredMessage) {
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index < 0) return [...messages, nextMessage];
  return messages.map((message, currentIndex) => (currentIndex === index ? nextMessage : message));
}

export function flattenProjectTree(nodes: ProjectTreeNode[], prefix = ""): ProjectTreeNode[] {
  return nodes.flatMap((node) => {
    const visibleNode = {
      ...node,
      path: prefix ? `${prefix}/${node.name}` : node.path
    };
    return [visibleNode, ...flattenProjectTree(node.children || [], visibleNode.path)];
  });
}

function getToolCallSummary(toolCall: ToolCall) {
  const name = toolCall.function.name;
  if (name === "search_web") return "正在搜索网页";
  if (name === "fetch_url") return "正在读取网页内容";
  if (name === "webbridge_command") return "正在操作真实浏览器";
  if (name === "read_file" || name === "read_attachment") return "正在读取文件";
  if (name === "write_file" || name === "replace_in_file") return "正在修改文件";
  if (name === "transform_image") return "正在生成修改后的图片";
  if (name === "run_tests") return "正在运行验证命令";
  if (name === "run_command") return "正在运行命令";
  return `正在调用 ${name}`;
}

function getToolSummary(message: ToolMessage) {
  if (message.toolName === "search_web") return "网页搜索完成";
  if (message.toolName === "fetch_url") return "网页读取完成";
  if (message.toolName === "webbridge_command") return "浏览器操作完成";
  if (message.toolName === "transform_image") return "图片处理完成";
  if (message.toolName === "write_file" || message.toolName === "replace_in_file") return "文件修改完成";
  if (message.toolName === "run_tests") return message.content.startsWith("Command failed") ? "验证未通过" : "验证完成";
  return "工具执行完成";
}

function getArtifactKind(filePath: string): Artifact["kind"] {
  const extension = filePath.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) return "image";
  if (["ppt", "pptx"].includes(extension)) return "presentation";
  if (["py", "js", "mjs", "ts", "tsx", "sh", "css", "json"].includes(extension)) return "code";
  if (["csv", "xlsx", "xls"].includes(extension)) return "table";
  return "file";
}

function getArtifactDescription(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase() || "";
  if (["ppt", "pptx"].includes(extension)) return `${extension.toUpperCase()} 演示文稿`;
  if (["html", "htm"].includes(extension)) return "网页文件产物";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) return "图片文件产物";
  if (["csv", "xlsx", "xls"].includes(extension)) return "表格数据产物";
  if (["py", "js", "mjs", "ts", "tsx", "sh"].includes(extension)) return `${extension.toUpperCase()} 脚本文件`;
  return "项目文件产物";
}

export const blockedCommandRules: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[;&|]\s*)rm(\s|$)/, reason: "file deletion is disabled" },
  { pattern: /\bfind\b[\s\S]*\s-delete(\s|$)/, reason: "find -delete is disabled" },
  { pattern: /\btrash\b|\btrash-put\b|\bgio\s+trash\b/, reason: "moving files to trash is disabled" },
  { pattern: /\bunlink\b/, reason: "unlink is disabled" },
  { pattern: /\brmdir\b/, reason: "directory deletion is disabled" },
  { pattern: /\brimraf\b/, reason: "recursive deletion is disabled" },
  { pattern: /\bshred\b/, reason: "secure deletion is disabled" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "destructive git reset is disabled" },
  { pattern: /\bgit\s+clean\b/, reason: "git clean deletes untracked files and is disabled" },
  { pattern: /\bgit\s+checkout\s+--\b/, reason: "discarding local changes is disabled" },
  { pattern: /\bsudo\b|\bsu\s+-?\b|\bdoas\b/, reason: "privilege escalation is disabled" },
  { pattern: />\s*\/dev\/(disk|rdisk|sda|nvme|mapper)\b/, reason: "writing to block devices is disabled" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b|\bdiskutil\s+erase|\bformat\s+[a-z]:/i, reason: "disk formatting is disabled" },
  { pattern: /\bdd\s+if=/, reason: "raw disk copy commands are disabled" },
  { pattern: /\bchmod\s+-R\s+777\b|\bchown\s+-R\b/, reason: "broad permission changes are disabled" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: "system power commands are disabled" }
];

export function assertCommandAllowed(command: string) {
  const blocked = getBlockedCommandReason(command);
  if (blocked) {
    throw new Error(`Command blocked by SuperCodex automatic safety policy (${blocked}): ${command}`);
  }
}

export function getBlockedCommandReason(command: string) {
  const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  return blockedCommandRules.find((rule) => rule.pattern.test(normalized))?.reason || "";
}

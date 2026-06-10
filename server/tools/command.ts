import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBlockedCommandReason } from "../core/security.js";

const execFileAsync = promisify(execFile);

const blockedExecutables = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "sudo",
  "su",
  "doas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "diskutil",
  "dd"
]);

export type StructuredCommand = {
  executable: string;
  args: string[];
  display: string;
  source: "argv" | "legacy";
};

export type CommandExecutionOptions = {
  cwd: string;
  timeout: number;
  maxBuffer: number;
};

export type CommandExecutionResult = {
  stdout: string;
  stderr: string;
};

export function normalizeCommandInput(args: Record<string, unknown>): StructuredCommand {
  const executable = typeof args.executable === "string" ? args.executable.trim() : "";
  const argv = Array.isArray(args.args) ? args.args.map((arg) => String(arg)) : [];

  if (executable) {
    const command = {
      executable,
      args: argv,
      display: formatCommand([executable, ...argv]),
      source: "argv" as const
    };
    assertStructuredCommandAllowed(command);
    return command;
  }

  const legacyCommand = String(args.command || "").trim();
  if (!legacyCommand) throw new Error("command or executable is required");
  const parts = parseLegacyCommand(legacyCommand);
  const command = {
    executable: parts[0] || "",
    args: parts.slice(1),
    display: legacyCommand,
    source: "legacy" as const
  };
  assertStructuredCommandAllowed(command);
  return command;
}

export async function executeStructuredCommand(
  command: StructuredCommand,
  options: CommandExecutionOptions
): Promise<CommandExecutionResult> {
  const result = await execFileAsync(command.executable, command.args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function assertStructuredCommandAllowed(command: StructuredCommand) {
  const executableName = command.executable.split(/[\\/]/).pop() || command.executable;
  if (blockedExecutables.has(executableName)) {
    throw new Error(`Command blocked by SuperCodex automatic safety policy (${executableName} is disabled): ${command.display}`);
  }

  const blocked = getBlockedCommandReason(formatCommand([command.executable, ...command.args]));
  if (blocked) {
    throw new Error(`Command blocked by SuperCodex automatic safety policy (${blocked}): ${command.display}`);
  }

  if (command.executable === "git") {
    const [subcommand, ...rest] = command.args;
    if (subcommand === "clean") {
      throw new Error(`Command blocked by SuperCodex automatic safety policy (git clean deletes untracked files and is disabled): ${command.display}`);
    }
    if (subcommand === "reset" && rest.includes("--hard")) {
      throw new Error(`Command blocked by SuperCodex automatic safety policy (destructive git reset is disabled): ${command.display}`);
    }
    if (subcommand === "checkout" && rest.includes("--")) {
      throw new Error(`Command blocked by SuperCodex automatic safety policy (discarding local changes is disabled): ${command.display}`);
    }
  }
}

function parseLegacyCommand(command: string) {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "" = "";
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/[;&|<>`]/.test(char) || char === "\n") {
      throw new Error(
        "Shell operators are not supported by the structured command runner. Run commands one step at a time."
      );
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in command");
  if (current) parts.push(current);
  if (!parts.length) throw new Error("command is required");
  return parts;
}

function formatCommand(parts: string[]) {
  return parts.map(quoteArg).join(" ");
}

function quoteArg(value: string) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

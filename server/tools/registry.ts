import type { RegisteredTool, ToolDefinition, ToolHandler, ToolMetadata } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, metadata: ToolMetadata, handler: ToolHandler) {
    this.tools.set(definition.function.name, { definition, metadata, handler });
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  definitions() {
    return this.list().map((tool) => tool.definition);
  }

  names() {
    return this.list().map((tool) => tool.definition.function.name);
  }
}

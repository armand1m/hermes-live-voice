// Argument readers for provider tool calls: trim strings and reject
// malformed values with messages the provider can relay.
import type { TaskExecutionMode } from "../../domain/tasks/index.js";
import type { LiveToolCall } from "./ports/realtime-model.port.js";

const MAX_TOOL_RESOURCE_KEYS = 8;

export function stringArg(call: LiveToolCall, name: string): string {
  const value = call.args[name];
  return typeof value === "string" ? value.trim() : "";
}

export function optionalStringArg(call: LiveToolCall, name: string): string | undefined {
  const value = stringArg(call, name);
  return value || undefined;
}

export function arrayArg(call: LiveToolCall, name: string): string[] | undefined {
  const value = call.args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Tool argument ${name} must be an array.`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Tool argument ${name} must contain non-empty strings.`);
    return item.trim();
  });
}

export function booleanArg(call: LiveToolCall, name: string, fallback: boolean): boolean {
  const value = call.args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

export function executionModeArg(call: LiveToolCall): TaskExecutionMode {
  const value = call.args.execution_mode;
  if (value === undefined) return "exclusive";
  if (value !== "exclusive" && value !== "parallel_read_only") {
    throw new Error("execution_mode must be exclusive or parallel_read_only.");
  }
  return value;
}

export function resourceKeysArg(call: LiveToolCall): string[] | undefined {
  const value = call.args.resource_keys;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_RESOURCE_KEYS) {
    throw new Error(`resource_keys must contain between 1 and ${MAX_TOOL_RESOURCE_KEYS} strings.`);
  }
  const keys = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256 || /[\u0000-\u001f\u007f]/u.test(item)) {
      throw new Error("resource_keys contains an invalid value.");
    }
    return item.trim();
  });
  return [...new Set(keys)];
}

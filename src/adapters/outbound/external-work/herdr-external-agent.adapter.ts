import { spawn } from "node:child_process";
import {
  ExternalAgentRuntimeStatusSchema,
  PaneIdSchema,
  type ExternalAgentRuntimeStatus,
} from "../../../domain/external-work/index.js";
import type { DelegationHost } from "../../../domain/tasks/delegation.js";
import type {
  ExternalAgentPort,
  ExternalAgentSnapshot,
} from "../../../application/external-work/ports/external-agent.port.js";

/**
 * herdr implementation of the external-agent port (plan §B). The local host
 * (exodia) runs herdr directly; the remote host (mac-mini) runs the same
 * herdr commands through the mssh wrapper. Every command has a hard deadline
 * and a bounded output budget; pane ids are pattern-validated before they can
 * reach the remote single-argument shell string.
 *
 * herdr's JSON envelope is `{"id":"cli:agent:list","result":{...}}`; unknown
 * agent statuses degrade to "unknown" rather than failing the whole snapshot.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const READ_OUTPUT_BUDGET = 256 * 1024;

export interface CommandRunner {
  run(
    command: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface HerdrExternalAgentOptions {
  herdrExecutable: string;
  msshExecutable: string;
  /** Host served by the local herdr binary (exodia in this deployment). */
  localHost: DelegationHost;
  /** Host served through the mssh wrapper (mac-mini in this deployment). */
  remoteHost: DelegationHost;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Injectable for tests; defaults to spawning real processes. */
  runner?: CommandRunner;
}

export class HerdrExternalAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrExternalAgentError";
  }
}

export class HerdrExternalAgentAdapter implements ExternalAgentPort {
  private readonly runner: CommandRunner;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(private readonly options: HerdrExternalAgentOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async listAgents(host: DelegationHost, options: { signal?: AbortSignal } = {}): Promise<ExternalAgentSnapshot[]> {
    const stdout = await this.runHerdr(host, ["agent", "list"], this.maxOutputBytes, options.signal);
    const envelope = parseJsonObject(stdout);
    const agents = envelope && Array.isArray((envelope.result as { agents?: unknown } | undefined)?.agents)
      ? ((envelope.result as { agents: unknown[] }).agents)
      : [];
    const snapshots: ExternalAgentSnapshot[] = [];
    for (const raw of agents) {
      if (!raw || typeof raw !== "object") continue;
      const agent = raw as Record<string, unknown>;
      const paneId = typeof agent.pane_id === "string" ? agent.pane_id : undefined;
      const sessionValue = readSessionValue(agent.agent_session);
      if (!paneId || !sessionValue) continue;
      if (!PaneIdSchema.safeParse(paneId).success) continue;
      snapshots.push({
        host,
        harness: "herdr",
        agentSessionValue: sessionValue,
        paneId,
        ...(typeof agent.workspace_id === "string" ? { workspaceId: agent.workspace_id } : {}),
        ...(typeof agent.name === "string" && agent.name.trim() ? { name: agent.name.trim().slice(0, 120) } : {}),
        status: normalizeStatus(agent.agent_status),
        revision: nonNegativeInt(agent.revision),
        stateChangeSeq: nonNegativeInt(agent.state_change_seq),
        cwd: typeof agent.cwd === "string" ? agent.cwd.slice(0, 512) : "",
        ...(typeof agent.terminal_title_stripped === "string" && agent.terminal_title_stripped.trim()
          ? { title: agent.terminal_title_stripped.trim().slice(0, 200) }
          : {}),
      });
    }
    return snapshots;
  }

  async readRecentOutput(
    host: DelegationHost,
    paneId: string,
    maxLines: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const lines = Math.max(1, Math.min(80, Math.floor(maxLines)));
    const validatedPane = PaneIdSchema.parse(paneId);
    const args = ["agent", "read", validatedPane, "--lines", String(lines), "--format", "text"];
    try {
      const stdout = await this.runHerdr(host, args, READ_OUTPUT_BUDGET, options.signal);
      return unwrapTextOutput(stdout).slice(-READ_OUTPUT_BUDGET);
    } catch (error) {
      // herdr cannot capture scrollback while an agent is working on an
      // alternate screen (live error code agent_not_idle): the visible screen
      // is still honest evidence, so fall back to it rather than losing the
      // excerpt entirely.
      if (!(error instanceof HerdrExternalAgentError) || !error.message.includes("agent_not_idle")) throw error;
      const stdout = await this.runHerdr(
        host,
        [...args, "--source", "visible"],
        READ_OUTPUT_BUDGET,
        options.signal,
      );
      return unwrapTextOutput(stdout).slice(-READ_OUTPUT_BUDGET);
    }
  }

  /**
   * Raw herdr command surface for the launch bridge (plan §C): same
   * transports, same deadline, same output bounds. Monitoring code never
   * needs this — it stays on the observe-only methods above.
   */
  async runCommand(
    host: DelegationHost,
    args: readonly string[],
    options: { signal?: AbortSignal; maxOutputBytes?: number } = {},
  ): Promise<string> {
    return this.runHerdr(host, args, options.maxOutputBytes ?? 512 * 1024, options.signal);
  }

  private async runHerdr(
    host: DelegationHost,
    herdrArgs: readonly string[],
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const command = this.commandFor(host, herdrArgs);
    const { stdout, stderr } = await this.runner.run(command, {
      timeoutMs: this.commandTimeoutMs,
      maxOutputBytes,
      signal,
    });
    if (!stdout.trim() && stderr.trim()) {
      throw new HerdrExternalAgentError(
        `herdr reported an error on ${host}: ${stderr.trim().slice(0, 300)}`,
      );
    }
    return stdout;
  }

  private commandFor(host: DelegationHost, herdrArgs: readonly string[]): string[] {
    if (host === this.options.localHost) {
      return [this.options.herdrExecutable, ...herdrArgs];
    }
    if (host === this.options.remoteHost) {
      // mssh takes one remote command string. Every interpolated value is
      // either a constant flag or pattern-validated (pane id, integer line
      // count), so nothing user-controlled can reach a shell metacharacter.
      return [this.options.msshExecutable, [this.options.herdrExecutable, ...herdrArgs].join(" ")];
    }
    throw new HerdrExternalAgentError(`No transport configured for host ${host}.`);
  }
}

/** Spawns real processes; kill on deadline, bound output, no shell. */
class ProcessRunner implements CommandRunner {
  run(
    command: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        signal: options.signal,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new HerdrExternalAgentError(`herdr command timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs);
      timer.unref?.();
      const settle = (error: unknown, result?: { stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxOutputBytes) {
          settle(new HerdrExternalAgentError("herdr command output exceeded the safe size limit."));
          child.kill("SIGKILL");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= options.maxOutputBytes) stderr.push(chunk);
      });
      child.on("error", (error) => settle(error));
      child.on("close", () => {
        // A non-zero exit with no stdout is surfaced by runHerdr as a
        // stderr-derived error; here we only collect what was produced.
        settle(null, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8").slice(0, 1_000),
        });
      });
    });
  }
}

function readSessionValue(agentSession: unknown): string | undefined {
  if (!agentSession || typeof agentSession !== "object") return undefined;
  const value = (agentSession as { value?: unknown }).value;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : undefined;
}

function normalizeStatus(value: unknown): ExternalAgentRuntimeStatus {
  const parsed = ExternalAgentRuntimeStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseJsonObject(stdout: string): { result?: unknown } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { result?: unknown } : undefined;
  } catch {
    return undefined;
  }
}

/** `agent read` returns plain text; tolerate a JSON envelope if one appears. */
function unwrapTextOutput(stdout: string): string {
  const envelope = parseJsonObject(stdout);
  if (!envelope) return stdout;
  const result = envelope.result;
  if (result && typeof result === "object") {
    for (const key of ["text", "output", "content"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return stdout;
}

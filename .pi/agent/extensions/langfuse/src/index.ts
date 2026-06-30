/**
 * Langfuse Observability Extension for Pi Coding Agent
 *
 * Sends traces to Langfuse for monitoring tokens, costs, latency, and tool calls.
 * Uses dynamic import to load the langfuse SDK properly.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================
// Configuration
// ============================================

interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
}

function loadConfig(): Config {
  // Primary: read from ~/.pi/agent/auth.json under "langfuse" key
  const authPath = resolve(process.env.HOME || "~", ".pi/agent/auth.json");
  if (existsSync(authPath)) {
    try {
      const content = readFileSync(authPath, "utf-8");
      const auth = JSON.parse(content) as Record<string, unknown>;
      const lf = auth.langfuse as Config | undefined;
      if (lf?.publicKey && lf?.secretKey) {
        return {
          publicKey: lf.publicKey,
          secretKey: lf.secretKey,
          host: lf.host || "https://cloud.langfuse.com",
        };
      }
    } catch (e) {
      console.warn("📊 Langfuse: Failed to load auth.json", e);
    }
  }

  // Fallback: config.json next to extension
  const configPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "config.json",
  );
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Config;
      if (config.publicKey && config.secretKey) {
        return {
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          host: config.host || "https://cloud.langfuse.com",
        };
      }
    } catch (e) {
      console.warn("📊 Langfuse: Failed to load config.json", e);
    }
  }

  return {
    publicKey: "",
    secretKey: "",
    host: "https://cloud.langfuse.com",
  };
}

const config = loadConfig();

// ============================================
// Langfuse Client (lazy-loaded via dynamic import)
// ============================================

interface LangfuseSpan {
  id: string;
  end(body?: {
    metadata?: Record<string, unknown>;
    isError?: boolean;
    output?: unknown;
  }): void;
}

interface LangfuseGeneration {
  id: string;
  end(body?: {
    metadata?: Record<string, unknown>;
    usage?: unknown;
    output?: unknown;
  }): void;
}

interface LangfuseClient {
  trace(body?: {
    name: string;
    metadata?: Record<string, unknown>;
    input?: unknown;
    output?: unknown;
    sessionId?: string;
  }): {
    id: string;
    update(body?: {
      metadata?: Record<string, unknown>;
      output?: unknown;
      input?: unknown;
    }): void;
  };
  span(body: {
    name: string;
    traceId: string;
    metadata?: Record<string, unknown>;
    input?: unknown;
  }): LangfuseSpan;
  generation(body: {
    name: string;
    traceId: string;
    metadata?: Record<string, unknown>;
    input?: unknown;
    output?: unknown;
    usage?: unknown;
  }): LangfuseGeneration;
  score(body: { name: string; value: number; traceId?: string }): void;
  shutdownAsync(): Promise<void>;
}

let client: LangfuseClient | null = null;

async function getClient(): Promise<LangfuseClient> {
  if (!client) {
    const extDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const lib = (await import(
      `${extDir}/node_modules/langfuse/lib/index.mjs`
    )) as {
      Langfuse: new (options: {
        publicKey: string;
        secretKey?: string;
        baseUrl?: string;
      }) => LangfuseClient;
    };
    client = new lib.Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
  }
  return client;
}

// ============================================
// Message conversion helpers
// ============================================

/**
 * Convert AgentMessage[] to OpenAI-style messages array for Langfuse.
 * Produces [{role, content}, ...] format matching Langfuse best practices.
 */
function toOpenAiMessages(
  messages: unknown[],
  systemPrompt: string,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];

  // Prepend system prompt as a system message
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;

    if (role === "user") {
      const content = m.content;
      if (typeof content === "string") {
        result.push({ role: "user", content });
      } else if (Array.isArray(content)) {
        // Extract text from content array
        const text = content
          .filter(
            (c: unknown) => (c as Record<string, unknown>)?.type === "text",
          )
          .map((c: unknown) => (c as Record<string, unknown>)?.text as string)
          .filter(Boolean)
          .join("\n");
        if (text) result.push({ role: "user", content: text });
      }
    } else if (role === "assistant") {
      const content = m.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .filter(Boolean)
          .join("\n");
        if (text) result.push({ role: "assistant", content: text });
      }
    } else if (role === "toolResult") {
      const content = m.content as Array<Record<string, unknown>> | undefined;
      const toolName = (m.toolName as string) || "unknown";
      if (content) {
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .filter(Boolean)
          .join("\n");
        if (text) {
          result.push({
            role: "tool_result",
            content: `[${toolName}] ${text.slice(0, 500)}`,
          });
        }
      }
    }
    // Skip custom message types (bashExecution, compactionSummary, etc.)
  }

  return result;
}

// ============================================
// State
// ============================================

interface TraceData {
  id: string;
  update?: (body?: {
    metadata?: Record<string, unknown>;
    output?: unknown;
    input?: unknown;
  }) => void;
}

let currentTrace: TraceData | null = null;
let currentSessionId: string = "";
let currentModel: string = "";
let currentProvider: string = "";
let currentSystemPrompt: string = "";
let currentMessages: unknown[] = [];
const activeSpans: Map<string, LangfuseSpan> = new Map();

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
  if (!config.publicKey || !config.secretKey) {
    console.log(
      "📊 Langfuse: Add langfuse credentials to ~/.pi/agent/auth.json to enable",
    );
    return;
  }

  // console.log("📊 Langfuse: Tracing enabled →", config.host);

  // Capture session ID on session start
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      // Extract session ID from file path (format: 2026-04-25T13-23-54-756Z_<uuid>.jsonl)
      const filename = sessionFile.split("/").pop() || "";
      currentSessionId = filename.replace(".jsonl", "");
    }
  });

  // Capture model info on model select
  pi.on("model_select", async (event, ctx) => {
    currentModel = event.model?.id || "";
    currentProvider = event.model?.provider || "";
  });

  // Capture user prompt, system prompt, and create trace
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const lf = await getClient();
      const cwd = event.systemPromptOptions?.cwd || process.cwd();
      currentSystemPrompt = event.systemPrompt || "";

      // Fallback to ctx.model if not captured via model_select
      if (!currentModel && ctx.model) {
        currentModel = ctx.model.id || "";
        currentProvider = ctx.model.provider || "";
      }

      // Create trace with user input and session ID
      currentTrace = lf.trace({
        name: "pi-agent",
        input: event.prompt,
        metadata: {
          cwd,
          model: currentModel,
          provider: currentProvider,
        },
        sessionId: currentSessionId || undefined,
      });
    } catch (e) {
      console.warn("📊 Langfuse: Failed to create trace", e);
    }
  });

  // Capture conversation messages before each LLM call
  pi.on("context", async (event) => {
    currentMessages = event.messages || [];
  });

  pi.on("agent_end", async (event) => {
    if (currentTrace) {
      // Get final response/output
      const eventData = event as unknown as {
        messages?: Array<{
          role: string;
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
          }>;
        }>;
      };
      const messages = eventData.messages || [];
      const lastAssistant = messages
        .filter((m) => m.role === "assistant")
        .pop();

      // Extract text from content array (filter out thinking blocks)
      let output: string | undefined;
      if (lastAssistant?.content) {
        output = lastAssistant.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
        if (output.length === 0) output = undefined;
      }

      currentTrace.update({
        output: output || undefined,
        metadata: {
          completed: true,
          totalTools: activeSpans.size,
          model: currentModel,
          provider: currentProvider,
        },
      });
      currentTrace = null;
    }
    activeSpans.clear();
    currentSystemPrompt = "";
    currentMessages = [];
    if (client) {
      await client.shutdownAsync();
      client = null;
    }
  });

  // Use tool_call instead of tool_execution_start - it has input
  pi.on("tool_call", async (event) => {
    if (!currentTrace) return;

    try {
      const lf = await getClient();

      // Format input nicely
      let inputStr = "";
      if (event.input) {
        inputStr = JSON.stringify(event.input, null, 2);
        if (inputStr.length > 1000) {
          inputStr = inputStr.slice(0, 1000) + "...";
        }
      }

      const span = lf.span({
        name: `tool:${event.toolName}`,
        traceId: currentTrace.id,
        input: inputStr,
        metadata: { tool: event.toolName },
      });
      activeSpans.set(event.toolCallId, span);
    } catch (e) {
      console.warn("📊 Langfuse: Failed to create span", e);
    }
  });

  pi.on("tool_result", async (event) => {
    const span = activeSpans.get(event.toolCallId);
    if (span) {
      // Format output nicely
      let outputStr = "";
      if (event.content && event.content.length > 0) {
        // Extract text from content array
        for (const item of event.content) {
          if (item.type === "text" && item.text) {
            outputStr += item.text;
          }
        }
        if (outputStr.length > 2000) {
          outputStr = outputStr.slice(0, 2000) + "...";
        }
      }

      span.end({
        isError: event.isError,
        output: outputStr || undefined,
      });
      activeSpans.delete(event.toolCallId);
    }
  });

  pi.on("turn_end", async (event) => {
    if (!currentTrace) return;

    const eventData = event as unknown as {
      message?: {
        role: string;
        content: Array<{ type: string; text?: string }>;
        model?: string;
        cost?: { input: number; output: number; total: number };
        usage?: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          totalTokens: number;
          cost?: { input: number; output: number; total: number };
        };
      };
      toolResults?: Array<{ toolName: string; toolCallId: string }>;
    };

    const message = eventData.message;
    if (!message || message.role !== "assistant") return;

    const usage = message.usage;
    const modelId = message.model || currentModel;
    const provider = currentProvider;
    // Cost is inside usage.cost, not message.cost
    const cost = usage?.cost;

    if (usage) {
      try {
        const lf = await getClient();

        // Extract output text
        let outputText = "";
        if (message.content) {
          outputText = message.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n");
        }

        // Build OpenAI-style messages array with system prompt + conversation
        const openAiMessages = toOpenAiMessages(
          currentMessages,
          currentSystemPrompt,
        );

        // Create generation for the LLM response with full context as input
        const gen = lf.generation({
          name: "llm-response",
          traceId: currentTrace.id,
          input: openAiMessages,
          output: outputText.slice(0, 1000),
          model: modelId,
          metadata: {
            provider: provider,
            inputTokens: usage.input || 0,
            outputTokens: usage.output || 0,
            cachedTokens: usage.cacheRead || 0,
          },
          usage: {
            input: usage.input || 0,
            output: usage.output || 0,
            total:
              usage.totalTokens || (usage.input || 0) + (usage.output || 0),
          },
          costDetails: cost
            ? {
                total: cost.total,
                input: cost.input,
                output: cost.output,
              }
            : undefined,
        });
        gen.end({
          costDetails: cost
            ? {
                total: cost.total,
                input: cost.input,
                output: cost.output,
              }
            : undefined,
          usage: {
            input: usage.input || 0,
            output: usage.output || 0,
            total:
              usage.totalTokens || (usage.input || 0) + (usage.output || 0),
          },
        });
      } catch (e) {
        console.warn("📊 Langfuse: Failed to create generation", e);
      }

      // Record token scores
      if (usage.input) {
        const lf = await getClient();
        lf.score({
          name: "input_tokens",
          value: usage.input,
          traceId: currentTrace.id,
        });
      }
      if (usage.output) {
        const lf = await getClient();
        lf.score({
          name: "output_tokens",
          value: usage.output,
          traceId: currentTrace.id,
        });
      }

      // Record cost if available
      if (cost?.total) {
        const lf = await getClient();
        lf.score({
          name: "total_cost",
          value: cost.total,
          traceId: currentTrace.id,
        });
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (currentTrace) {
      if (currentTrace.update) {
        currentTrace.update({ metadata: { completed: true } });
      }
      currentTrace = null;
    }
    if (client) {
      await client.shutdownAsync();
      client = null;
    }
  });
}

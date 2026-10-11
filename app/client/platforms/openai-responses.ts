import {
  ChatMessageTool,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "@/app/store";
import { preProcessImageContent } from "@/app/utils/chat";
import { fetch } from "@/app/utils/stream";
import { ChatOptions, getHeaders, MultimodalContent } from "../api";

/**
 * Responses API for GPT-6. Retain the existing Chat Completions client for
 * older models so Vercel deployments and other providers are unaffected.
 *
 * Stateless tool turns pass response.output (including encrypted reasoning
 * items) back as input. This deliberately uses store:false for user privacy.
 */
export async function chatWithResponses(
  options: ChatOptions,
  chatPath: string,
): Promise<void> {
  const modelConfig = {
    ...useAppConfig.getState().modelConfig,
    ...useChatStore.getState().currentSession().mask.modelConfig,
    model: options.config.model,
  };
  const abort = new AbortController();
  options.onController?.(abort);

  const input: any[] = [];
  for (const message of options.messages) {
    const content = await preProcessImageContent(message.content);
    if (typeof content === "string") {
      input.push({ role: message.role, content });
    } else {
      const parts = (content as MultimodalContent[]).map((part) => {
        if (part.type === "image_url") {
          return {
            type: "input_image",
            image_url: part.image_url?.url,
          };
        }
        return { type: "input_text", text: part.text ?? "" };
      });
      input.push({ role: message.role, content: parts });
    }
  }

  const [providedTools, funcs] = usePluginStore
    .getState()
    .getAsTools(useChatStore.getState().currentSession().mask?.plugin || []);

  const tools = providedTools
    .filter((tool) => !!tool?.function?.name)
    .map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || {
        type: "object",
        properties: {},
      },
    }));

  const shouldStream = !!options.config.stream;
  let responseText = "";
  let currentInput = input;

  try {
    for (let round = 0; round < 8; round++) {
      if (abort.signal.aborted) return;

      const body = {
        model: modelConfig.model,
        input: currentInput,
        stream: shouldStream,
        store: false,
        // Keep reasoning state across stateless tool turns.
        ...(tools.length ? { include: ["reasoning.encrypted_content"] } : {}),
        max_output_tokens: Math.max(
          modelConfig.model === "gpt-6.1-sol" ? 8192 : 4096,
          modelConfig.max_tokens ?? 4096,
        ),
        ...(tools.length ? { tools } : {}),
      };

      const res = await fetch(chatPath, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) {
        throw new Error(
          `Responses API HTTP ${res.status}: ${(await res.text()).slice(0, 1500)}`,
        );
      }

      let output: any[] = [];
      if (shouldStream) {
        if (!res.body) {
          throw new Error("Responses API returned no streaming body");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const completedItems = new Map<string, any>();
        let buffer = "";

        const handleEvent = (data: string) => {
          if (data === "[DONE]") return;
          const event = JSON.parse(data);
          if (event.type === "error" || event.type === "response.failed") {
            const err = event.error || event.response?.error;
            throw new Error(err?.message || JSON.stringify(event));
          }
          if (event.type === "response.output_text.delta" && event.delta) {
            responseText += event.delta;
            options.onUpdate?.(responseText, event.delta);
          }
          if (event.type === "response.output_item.done" && event.item) {
            completedItems.set(
              event.item.id || String(event.output_index),
              event.item,
            );
          }
          if (event.type === "response.completed" && event.response) {
            output = event.response.output || [];
          }
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const raw = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = raw
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data) handleEvent(data);
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!output.length) output = Array.from(completedItems.values());
      } else {
        const json = await res.json();
        if (json.error) throw new Error(json.error.message || "Responses API error");
        output = json.output || [];
      }

      const functionCalls = output.filter(
        (item) => item.type === "function_call" && item.call_id && item.name,
      );
      if (!shouldStream || !responseText) {
        const newText = output
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content || [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text || "")
          .join("");
        if (newText) {
          // Streaming deltas were already appended; avoid duplicates.
          if (!shouldStream || !responseText.endsWith(newText)) {
            responseText += newText;
            options.onUpdate?.(responseText, newText);
          }
        }
      }

      if (!functionCalls.length) {
        options.onFinish(responseText, res);
        return;
      }

      const results: any[] = [];
      for (const call of functionCalls) {
        const toolMessage: ChatMessageTool = {
          id: call.call_id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments || "{}",
          },
        };
        options.onBeforeTool?.(toolMessage);
        let resultText = "";
        try {
          const fn = funcs[call.name];
          if (!fn) throw new Error(`Tool not found: ${call.name}`);
          const args = JSON.parse(call.arguments || "{}");
          const result = await Promise.resolve(fn(args));
          if (result?.status >= 300) {
            throw new Error(String(result?.data ?? result?.statusText));
          }
          const data = result?.data ?? result?.statusText ?? result;
          resultText = typeof data === "string" ? data : JSON.stringify(data);
          options.onAfterTool?.({
            ...toolMessage,
            content: resultText,
            isError: false,
          });
        } catch (e) {
          resultText = e instanceof Error ? e.message : String(e);
          options.onAfterTool?.({
            ...toolMessage,
            isError: true,
            errorMsg: resultText,
          });
        }
        results.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: resultText || "",
        });
      }
      // The next request includes function_call objects and any encrypted
      // reasoning items returned by the previous turn.
      currentInput = [...currentInput, ...output, ...results];
    }
    throw new Error("Responses API exceeded maximum tool-call rounds (8)");
  } catch (error) {
    if (!abort.signal.aborted) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

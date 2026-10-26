/** Constant `DEFAULT_N_CTX` defining default n ctx. */
export const DEFAULT_N_CTX = 4096;
export const TRUNCATION_MARKER = "[...TRUNCATED BY REPOMCP CONTEXT GUARD...]";
const IM_END = "<|" + "redacted_im_end" + "|>";
export const MULTI_FAMILY_STOP_SEQUENCES = [
    "</tool_call>",
    "</tool_calls>",
    IM_END,
    "<|eot_id|>",
    "<|end|>",
    "<|observation|>",
    "<|tool_calls_section_end|>",
    "<\uFF5Ctool\u2581calls\u2581end\uFF5C>",
    "\n\u273FRESULT\u273F",
    "\nOBS:",
    "\nObservation:",
    "\nUSER:",
    "\nHuman:",
];
/** Configuration and data shape for `NCtxProbeResult` (nctx probe result). */
export type NCtxProbeResult = {
    nCtx: number;
    source: "llama.cpp" | "ollama" | "vllm" | "fallback";
};

/** Executes `probeNCtx` to probe nctx in `repomcp`. */
export async function probeNCtx(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<NCtxProbeResult> {
    const base = baseUrl.replace(/\/$/, "");
    try {
        const props = await fetchImpl(`${base}/props`);
        if (props.ok) {
            const j = (await props.json());
            const n = j.n_ctx ?? j.default_generation_settings?.n_ctx;
            if (typeof n === "number" && n > 0)
                return { nCtx: n, source: "llama.cpp" };
        }
    }
    catch {
        /* continue */
    }
    try {
        const show = await fetchImpl(`${base}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "dummy" }),
        });
        if (show.ok) {
            const j = (await show.json());
            const info = j.model_info ?? {};
            for (const [k, v] of Object.entries(info)) {
                if (k.includes("context_length") && typeof v === "number" && v > 0) {
                    return { nCtx: v, source: "ollama" };
                }
            }
        }
    }
    catch {
        /* continue */
    }
    try {
        const models = await fetchImpl(`${base}/v1/models`);
        if (models.ok) {
            const j = (await models.json());
            const first = j.data?.[0];
            if (first?.max_model_len && first.max_model_len > 0) {
                return { nCtx: first.max_model_len, source: "vllm" };
            }
        }
    }
    catch {
        /* continue */
    }
    return { nCtx: DEFAULT_N_CTX, source: "fallback" };
}
/** Head 60% + tail 40% by character budget (approx token guard). */
export function headTailTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars)
        return text;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.floor(maxChars * 0.4) - TRUNCATION_MARKER.length;
    if (tailLen < 0)
        return text.slice(0, maxChars);
    return text.slice(0, headLen) + TRUNCATION_MARKER + text.slice(-tailLen);
}
export function toolOutputBudgetChars(nCtx: number, charsPerToken = 4): number {
    return Math.floor(nCtx * charsPerToken * 0.3);
}
/** Executes `truncateToolOutput` to truncate tool output in `repomcp`. */
export function truncateToolOutput(text: string, nCtx: number): string {
    return headTailTruncate(text, toolOutputBudgetChars(nCtx));
}
/** Executes `buildRecencyAnchor` to build recency anchor in `repomcp`. */
export function buildRecencyAnchor(sigs: { name: string; summary: string }[]): string {
    const lines = sigs.map((s) => `- ${s.name}: ${s.summary}`);
    return [
        "[AVAILABLE TOOLS - ANCHORED FOR RECENCY]",
        ...lines,
        'To call a tool, output ONLY: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    ].join("\n");
}
/** Executes `anchorPromptTail` to anchor prompt tail in `repomcp`. */
export function anchorPromptTail(prompt: string, anchor: string): string {
    const marker = "\nASSISTANT:";
    const idx = prompt.lastIndexOf(marker);
    if (idx === -1) {
        return `${prompt}\n\n${anchor}\n${marker}`;
    }
    const before = prompt.slice(0, idx);
    const after = prompt.slice(idx);
    return `${before}\n\n${anchor}\n${after}`;
}
export function pickRawCompletionEndpoint(baseUrl: string, prefer?: string): string {
    if (prefer)
        return prefer;
    if (baseUrl.includes("11434") || baseUrl.includes("ollama")) {
        return "/v1/completions";
    }
    return "/v1/completions";
}
export async function chatOrRawFallback(
    baseUrl: string,
    chatPath: string,
    rawPath: string,
    options: { forceRaw?: boolean; fetchImpl?: typeof fetch },
): Promise<{ mode: "raw" | "chat"; path: string }> {
    if (options.forceRaw) {
        return { mode: "raw", path: rawPath };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${chatPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "probe", messages: [] }),
        });
        if (res.status === 400 || res.status === 404 || res.status === 501) {
            return { mode: "raw", path: rawPath };
        }
    }
    catch {
        return { mode: "raw", path: rawPath };
    }
    return { mode: "chat", path: chatPath };
}
export function injectStopSequences(body: Record<string, unknown>): Record<string, unknown> {
    const existing = Array.isArray(body.stop) ? body.stop : [];
    const merged = [...new Set([...existing, ...MULTI_FAMILY_STOP_SEQUENCES])];
    return { ...body, stop: merged };
}
export class StreamToolJsonAbort {
    depth = 0;
    started = false;
    acc = "";
    feed(chunk: string): boolean {
        this.acc += chunk;
        if (!this.started) {
            if (/<tool_call>/i.test(this.acc) ||
                /\u273FFUNCTION\u273F/i.test(this.acc) ||
                /<\|tool_call_argument_begin\|>/i.test(this.acc) ||
                /"name"\s*:\s*"/.test(this.acc)) {
                this.started = true;
            }
        }
        this.depth = countBraceFrom(this.acc);
        return this.started && this.depth === 0 && /\{[\s\S]*\}/.test(this.acc);
    }
    reset() {
        this.depth = 0;
        this.started = false;
        this.acc = "";
    }
}
function countBraceFrom(text: string): number {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (c === "\\")
                escape = true;
            else if (c === '"')
                inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            continue;
        }
        if (c === "{")
            depth++;
        else if (c === "}")
            depth--;
    }
    return depth;
}
export async function readStreamUntilToolJsonDone(
    stream: ReadableStream<Uint8Array>,
    onAbort: () => void,
): Promise<string> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    const guard = new StreamToolJsonAbort();
    let out = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        const chunk = decoder.decode(value, { stream: true });
        out += chunk;
        if (guard.feed(chunk)) {
            onAbort();
            break;
        }
    }
    return out;
}

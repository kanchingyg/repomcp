import type { DirtyToolCall, JsonSchema, JsonSchemaProperty } from "./types.js";

/** Remove thinking blocks before parsing tool calls. */
export function stripRedactedThinking(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/redacted_thinking>|$)/gi, "");
}

function repairJson(raw: string): string {
    let s = raw.trim();
    if (!s)
        return "{}";
    s = s.replace(/\/\/[^\n]*/g, "");
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    s = s.replace(/,\s*([}\]])/g, "$1");
    s = s.replace(/'/g, '"');
    s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    const open = (s.match(/\{/g) ?? []).length;
    const close = (s.match(/\}/g) ?? []).length;
    if (open > close) {
        s += "}".repeat(open - close);
    }
    return s;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
    const attempts = [raw, repairJson(raw)];
    for (const a of attempts) {
        try {
            const v = JSON.parse(a) as unknown;
            if (v && typeof v === "object" && !Array.isArray(v)) {
                return v as Record<string, unknown>;
            }
        }
        catch {
            /* next */
        }
    }
    return null;
}

function coerceValue(value: unknown, prop: JsonSchemaProperty | undefined): unknown {
    if (!prop?.type)
        return value;
    switch (prop.type) {
        case "integer":
            if (typeof value === "string" && /^-?\d+$/.test(value))
                return parseInt(value, 10);
            if (typeof value === "number")
                return Math.trunc(value);
            return value;
        case "number":
            if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))
                return Number(value);
            return value;
        case "boolean":
            if (value === "true")
                return true;
            if (value === "false")
                return false;
            return value;
        case "array":
            if (typeof value === "string") {
                try {
                    return JSON.parse(value) as unknown;
                }
                catch {
                    return value;
                }
            }
            return value;
        default:
            return value;
    }
}

export function coerceToSchema(
    args: Record<string, unknown>,
    schema: JsonSchema | undefined,
): Record<string, unknown> {
    if (!schema?.properties)
        return args;
    const out = { ...args };
    for (const [key, prop] of Object.entries(schema.properties)) {
        if (key in out)
            out[key] = coerceValue(out[key], prop);
    }
    return out;
}

/** Lexical brace balancer for streaming stop (ignores strings). */
export function countJsonBraceDepth(chunk: string, priorDepth: number): number {
    let depth = priorDepth;
    let inString = false;
    let escape = false;
    for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
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

export function shouldAbortStreamOnToolJson(accumulated: string, started: boolean, depth: number): boolean {
    if (!started)
        return false;
    return depth === 0 && /\{[\s\S]*\}/.test(accumulated);
}

export function parseDirtyToolCall(content: string, schema?: JsonSchema): DirtyToolCall | null {
    const text = stripRedactedThinking(content);
    const hermes = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
    if (hermes) {
        const obj = tryParseObject(hermes[1]);
        if (obj?.name && typeof obj.name === "string") {
            const args = (obj.arguments ?? obj.args ?? {}) as Record<string, unknown>;
            return {
                name: obj.name,
                arguments: coerceToSchema(args, schema),
            };
        }
    }
    const minimax = text.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i);
    if (minimax) {
        const obj = tryParseObject(minimax[1]);
        if (obj?.name && typeof obj.name === "string") {
            return {
                name: obj.name,
                arguments: coerceToSchema((obj.arguments ?? {}) as Record<string, unknown>, schema),
            };
        }
    }
    const deepseek = text.match(/<\|redacted_tool_call_begin\|>[\s\S]*?```json\s*([\s\S]*?)```[\s\S]*?<\|redacted_tool_call_end\|>/i);
    if (deepseek) {
        const obj = tryParseObject(deepseek[1]);
        if (obj) {
            const name = obj.name ?? obj.function ?? obj.tool;
            if (name) {
                return {
                    name: String(name),
                    arguments: coerceToSchema(obj, schema),
                };
            }
        }
    }
    const kimi = text.match(/functions\.([^:<\|]+):\d+<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/i);
    if (kimi) {
        const obj = tryParseObject(kimi[2]);
        return {
            name: kimi[1].trim(),
            arguments: coerceToSchema(obj ?? {}, schema),
        };
    }
    const glm = text.match(
      /<\|(?:redacted_tool_call_begin_kimi|tool_call_begin)\|>([^<\|]+)<\|tool_call_sep\|>([\s\S]*?)<\|(?:redacted_tool_call_end_kimi|tool_call_end)\|>/i,
    );
    if (glm) {
        const obj = tryParseObject(glm[2]);
        return {
            name: glm[1].trim(),
            arguments: coerceToSchema(obj ?? {}, schema),
        };
    }
    const qwenFn = text.match(/\u273FFUNCTION\u273F:\s*([^\n]+)\s*\u273FARGS\u273F:\s*([\s\S]*?)(?:\u273FRESULT\u273F|$)/i);
    if (qwenFn) {
        const obj = tryParseObject(qwenFn[2]);
        return {
            name: qwenFn[1].trim(),
            arguments: coerceToSchema(obj ?? {}, schema),
        };
    }
    const step3 = text.match(/<steptml:invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/steptml:invoke>/i);
    if (step3) {
        const args: Record<string, string> = {};
        const paramRe = /<steptml:parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/steptml:parameter>/gi;
        let m: RegExpExecArray | null;
        while ((m = paramRe.exec(step3[2])) !== null) {
            args[m[1]] = m[2].trim();
        }
        return { name: step3[1], arguments: coerceToSchema(args, schema) };
    }
    const py = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/m);
    if (py) {
        const args: Record<string, string> = {};
        const inner = py[2].trim();
        if (inner) {
            for (const part of inner.split(",")) {
                const eq = part.indexOf("=");
                if (eq > 0) {
                    const k = part.slice(0, eq).trim();
                    let v = part.slice(eq + 1).trim();
                    if (typeof v === "string" && /^["']/.test(v)) {
                        v = v.slice(1, -1);
                    }
                    args[k] = v;
                }
            }
        }
        return { name: py[1], arguments: coerceToSchema(args, schema) };
    }
    const openAiBlock = text.match(/\{\s*"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*\})/);
    if (openAiBlock) {
        const obj = tryParseObject(`{"name":"${openAiBlock[1]}","arguments":${openAiBlock[2]}}`);
        if (obj?.name) {
            return {
                name: String(obj.name),
                arguments: coerceToSchema((obj.arguments ?? {}) as Record<string, unknown>, schema),
            };
        }
    }
    const iqBroken = text.match(/\{\s*['"]?cmd['"]?\s*:\s*['"]([^'"]+)['"]/);
    if (iqBroken) {
        return { name: "run_shell", arguments: { cmd: iqBroken[1] } };
    }
    return null;
}

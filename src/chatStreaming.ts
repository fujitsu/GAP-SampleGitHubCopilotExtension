import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';

interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value !== 'string') {
        throw new Error('Invalid streaming response: expected a string');
    }
    return value;
}

export async function reportChatCompletionStream(
    stream: AsyncIterable<Buffer>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Promise<void> {
    const decoder = new StringDecoder('utf8');
    const tools = new Map<number, ToolCall>();
    let buffer = '';
    let data: string[] = [];
    let done = false;

    const dispatch = () => {
        if (data.length === 0) {
            return;
        }
        const payload = data.join('\n');
        data = [];
        if (payload === '[DONE]') {
            done = true;
            return;
        }
        const event: unknown = JSON.parse(payload);
        if (!isRecord(event)) {
            throw new Error('Invalid streaming response: expected an object');
        }
        if (event.error) {
            throw new Error(`Streaming API error: ${JSON.stringify(event.error)}`);
        }
        if (!Array.isArray(event.choices)) {
            throw new Error('Invalid streaming response: missing choices');
        }
        const choice: unknown = event.choices.find((item: unknown) => isRecord(item) && item.index === 0)
            ?? event.choices[0];
        if (!choice) {
            return;
        }
        if (!isRecord(choice)) {
            throw new Error('Invalid streaming response: invalid choice');
        }
        const delta = choice.delta;
        if (!isRecord(delta)) {
            throw new Error('Invalid streaming response: missing delta');
        }
        const content = optionalString(delta.content);
        if (content) {
            progress.report(new vscode.LanguageModelTextPart(content));
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) {
                throw new Error('Invalid streaming response: tool_calls is not an array');
            }
            for (const part of delta.tool_calls) {
                if (!isRecord(part) || typeof part.index !== 'number'
                    || !Number.isInteger(part.index) || part.index < 0) {
                    throw new Error('Invalid streaming response: missing tool call index');
                }
                if (part.function !== undefined && part.function !== null && !isRecord(part.function)) {
                    throw new Error('Invalid streaming response: invalid tool function');
                }
                const fn = isRecord(part.function) ? part.function : {};
                const tool = tools.get(part.index) ?? { id: '', name: '', arguments: '' };
                tool.id += optionalString(part.id);
                tool.name += optionalString(fn.name);
                tool.arguments += optionalString(fn.arguments);
                tools.set(part.index, tool);
            }
        }
    };

    const consume = (end: boolean) => {
        while (!done) {
            const match = /[\r\n]/.exec(buffer);
            if (!match || (!end && match[0] === '\r' && match.index === buffer.length - 1)) {
                break;
            }
            const line = buffer.slice(0, match.index);
            const delimiterLength = buffer[match.index] === '\r' && buffer[match.index + 1] === '\n' ? 2 : 1;
            buffer = buffer.slice(match.index + delimiterLength);
            if (line === '') {
                dispatch();
            } else if (line.startsWith('data:')) {
                const value = line.slice(5);
                data.push(value.startsWith(' ') ? value.slice(1) : value);
            } else if (line === 'data') {
                data.push('');
            }
        }
    };

    for await (const chunk of stream) {
        buffer += decoder.write(chunk);
        consume(false);
        if (done) {
            break;
        }
    }
    if (!done) {
        buffer += decoder.end();
        consume(true);
    }
    if (!done) {
        throw new Error('Streaming response ended before [DONE]');
    }
    for (const [, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
        if (!tool.id || !tool.name || !tool.arguments) {
            throw new Error('Invalid streaming response: incomplete tool call');
        }
        progress.report(new vscode.LanguageModelToolCallPart(tool.id, tool.name, JSON.parse(tool.arguments)));
    }
}

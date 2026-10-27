import * as vscode from 'vscode';
import axios from 'axios';
import { AuthManager } from './authManager';

export class CustomModelProvider implements vscode.LanguageModelChatProvider {
    readonly name = 'Fujitsu Cloud Service Generative AI Platform Custom Model';
    readonly id = 'Fujitsu-GAP';
    readonly version = '1.0.0';
    readonly family = 'fujitsu-gap';
    readonly maxInputTokens: number;

    private authManager: AuthManager;
    private tenantName: string;
    private cachedToken: string | null = null;

    constructor(context: vscode.ExtensionContext, tenantName: string, clientId: string, maxInputTokens: number) {
        this.tenantName = tenantName;
        this.maxInputTokens = maxInputTokens;
        this.authManager = new AuthManager(context, this.tenantName, clientId);
    }

    // 1. モデル情報の提供
    async provideLanguageModelChatInformation(options: any, token: vscode.CancellationToken): Promise<any[]> {
        return [{
            id: this.id,
            name: this.name,
            version: this.version,
            family: this.family,
            maxInputTokens: this.maxInputTokens,
            maxOutputTokens: 32000,
            capabilities: {
                toolCalling: true,
                imageInput: true 
            },
            editTools: []
        }];
    }

    // 2. チャットレスポンスの提供
    async provideLanguageModelChatResponse(
        model: any,
        messages: readonly any[],
        options: any,
        progress: any,
        token: vscode.CancellationToken
    ): Promise<any> {
        const api = `https://${this.tenantName}.generative-ai-platform.cloud.global.fujitsu.com/api/v1/pass-through/takane/compatibility/v1/chat/completions`;

        // 履歴メッセージをOpenAI形式（テキスト・ツール呼び出し・ツール結果）に正しく変換
        const formattedMessages: any[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
            
            let textContent = '';
            let toolCalls: any[] = [];
            let toolResults: any[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textContent += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push({
                        id: part.callId,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: JSON.stringify(part.input)
                        }
                    });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    let resultText = '';
                    for (const subPart of part.content) {
                        if (subPart instanceof vscode.LanguageModelTextPart) {
                            resultText += subPart.value;
                        } else {
                            resultText += JSON.stringify(subPart);
                        }
                    }
                    toolResults.push({
                        toolCallId: part.callId,
                        content: resultText
                    });
                }
            }

            // ツールの実行結果がある場合は OpenAI の role: "tool" メッセージとして追加
            if (toolResults.length > 0) {
                for (const tr of toolResults) {
                    formattedMessages.push({
                        role: 'tool',
                        tool_call_id: tr.toolCallId,
                        content: tr.content
                    });
                }
            } else {
                const messageObj: any = {
                    role: role,
                    content: textContent || null
                };
                if (toolCalls.length > 0) {
                    messageObj.tool_calls = toolCalls;
                }
                formattedMessages.push(messageObj);
            }
        }

        const modelName = "takane";
        const requestBody: any = {
            model: modelName,
            messages: formattedMessages,
            stream: false
        };

        // Tool Use (tools) の定義をリクエストに追加
        if (options && options.tools && options.tools.length > 0) {
            requestBody.tools = options.tools.map((tool: any) => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                }
            }));
            if (options.toolMode) {
                requestBody.tool_choice = 'auto';
            }
        }

        const makeRequest = async (idToken: string) => {
            return await axios.post(
                api,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    }
                }
            );
        };

        let responseText = '';
        let toolCalls: any[] = [];

        try {
            if (!this.cachedToken) {
                this.cachedToken = await this.authManager.getIdToken();
            }

            try {
                const response = await makeRequest(this.cachedToken);
                const choice = response.data.choices?.[0];
                responseText = choice?.message?.content || '';
                toolCalls = choice?.message?.tool_calls || [];
            } catch (error: any) {
                if (error.response?.status === 401) {
                    console.log("Token expired, refreshing token...");
                    this.cachedToken = await this.authManager.getIdToken();
                    const retryResponse = await makeRequest(this.cachedToken);
                    const choice = retryResponse.data.choices?.[0];
                    responseText = choice?.message?.content || '';
                    toolCalls = choice?.message?.tool_calls || [];
                } else {
                    throw error;
                }
            }

        } catch (error: any) {
            throw new Error(`API request failed: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
        }

        // モデルからツール呼び出しが要求された場合
        if (toolCalls && toolCalls.length > 0 && progress && typeof progress.report === 'function') {
            for (const toolCall of toolCalls) {
                try {
                    progress.report(new vscode.LanguageModelToolCallPart(
                        toolCall.id,
                        toolCall.function.name,
                        JSON.parse(toolCall.function.arguments || '{}')
                    ));
                } catch (e) {}
            }
        }

        // 通常テキスト応答がある場合
        if (responseText && progress && typeof progress.report === 'function') {
            try {
                progress.report(new vscode.LanguageModelTextPart(responseText));
            } catch (e) {}
        }

        return {
            stream: (async function* () {
                if (responseText) {
                    yield new vscode.LanguageModelTextPart(responseText);
                }
            })(),
            text: responseText
        };
    }

    // 3. トークン数の計算
    async provideTokenCount(model: any, text: any, token: vscode.CancellationToken): Promise<number> {
        let content = '';
        if (typeof text === 'string') {
            content = text;
        } else if (text && typeof text.content === 'string') {
            content = text.content;
        }
        return Math.ceil(content.length / 4);
    }
}
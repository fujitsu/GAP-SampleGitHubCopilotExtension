import * as vscode from 'vscode';
import { CustomModelProvider } from './modelProvider';

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('fujitsuGap');
    const tenantName = config.get<string>('tenantName') || '';
    const clientId = config.get<string>('clientId');
    const maxInputTokens = config.get<number>('maxInputTokens') ?? (256 * 1024);

    if (!clientId) {
        vscode.window.showWarningMessage('Fujitsu GAP: 設定画面 から「Tenant Name」と「Client ID」を入力してください。');
    }

    const provider = new CustomModelProvider(context, tenantName, clientId || '', maxInputTokens);

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(provider.id, provider as any)
    );

    console.log('Fujitsu Cloud Service Generative AI Platform Provider is active!');
}

export function deactivate() {}
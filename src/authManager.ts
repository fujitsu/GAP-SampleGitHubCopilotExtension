import * as msal from '@azure/msal-node';
import * as vscode from 'vscode';

export class AuthManager {
    private clientApp: msal.PublicClientApplication;
    private tenantName: string;
    private clientId: string;
    private context: vscode.ExtensionContext;
    private readonly scopes = ['openid', 'offline_access'];

    constructor(context: vscode.ExtensionContext, tenantName: string, clientId: string) {
        this.context = context;
        this.tenantName = tenantName;
        this.clientId = clientId;

        const b2cDomain = `${this.tenantName}.b2clogin.com`;
        const signInPolicy = 'B2C_1_fjcloud_genai_susi';
        const authority = `https://${b2cDomain}/${this.tenantName}.onmicrosoft.com/${signInPolicy}`;

        const cachePlugin: msal.ICachePlugin = {
            beforeCacheAccess: async (cacheContext) => {
                const cachedData = await this.context.secrets.get('msal_token_cache');
                if (cachedData) {
                    cacheContext.tokenCache.deserialize(cachedData);
                }
            },
            afterCacheAccess: async (cacheContext) => {
                if (cacheContext.cacheHasChanged) {
                    await this.context.secrets.store('msal_token_cache', cacheContext.tokenCache.serialize());
                }
            }
        };

        const clientConfig: msal.Configuration = {
            auth: {
                clientId: this.clientId,
                authority,
                knownAuthorities: [b2cDomain]
            },
            cache: {
                cachePlugin
            }
        };

        this.clientApp = new msal.PublicClientApplication(clientConfig);
    }

    /**
     * 初回起動時のみ msal_token_cache をクリアする初期化メソッド
     */
    async initialize(): Promise<void> {
        const isInitialized = this.context.globalState.get<boolean>('msal_cache_initialized', false);
        
        if (!isInitialized) {
            // 初回起動時のみSecretStorageからキャッシュを削除
            await this.context.secrets.delete('msal_token_cache');
            // フラグを更新して、次回以降はクリアされないようにする
            await this.context.globalState.update('msal_cache_initialized', true);
            console.log("Initial run detected: msal_token_cache has been cleared.");
        }
    }

    async getIdToken(): Promise<string> {
        const tokenCache = this.clientApp.getTokenCache();
        const accounts = await tokenCache.getAllAccounts();

        // 1. ログイン済みの認証情報を使ってサイレント更新を試みる
        if (accounts.length > 0) {
            try {
                const silentRequest: msal.SilentFlowRequest = {
                    account: accounts[0],
                    scopes: this.scopes,
                };
                const result = await this.clientApp.acquireTokenSilent(silentRequest);
                if (result && result.idToken) {
                    return result.idToken;
                }
            } catch (error) {
                console.warn("Silent token acquisition failed, falling back to interactive flow.", error);
            }
        }

        // 2. サイレント失敗時は対話認証（ブラウザ起動 ＋ ローカルループバック）を実行
        try {
            const response = await this.clientApp.acquireTokenInteractive({
                scopes: this.scopes,
                openBrowser: async (url: string) => {
                    vscode.window.showInformationMessage('認証用のブラウザを開きます。ログインを行ってください。');
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                },
                successTemplate: '<h1>Authentication complete!</h1><p>You can close this tab and return to VS Code.</p>',
            });

            if (response && response.idToken) {
                return response.idToken;
            }
        } catch (error) {
            throw new Error(`Interactive authentication failed: ${error}`);
        }

        throw new Error("Could not acquire ID token.");
    }
}
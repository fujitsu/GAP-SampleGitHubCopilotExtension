import * as msal from '@azure/msal-node';
import * as vscode from 'vscode';

export class AuthManager {
    private clientApp: msal.PublicClientApplication;
    private tenantName: string;
    private clientId: string;
    private context: vscode.ExtensionContext;
    private readonly scopes = ['openid', 'offline_access'];
    private readonly idTokenCacheKey: string;
    private tokenRequest: Promise<string> | undefined;

    constructor(context: vscode.ExtensionContext, tenantName: string, clientId: string) {
        this.context = context;
        this.tenantName = tenantName;
        this.clientId = clientId;

        const b2cDomain = `${this.tenantName}.b2clogin.com`;
        const signInPolicy = 'B2C_1_fjcloud_genai_susi';
        const authority = `https://${b2cDomain}/${this.tenantName}.onmicrosoft.com/${signInPolicy}`;
        this.idTokenCacheKey = `fujitsuGap.idToken:${authority}:${this.clientId}`;

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
     * トークンを取得します。
     * 有効な ID トークンを再利用し、期限切れ時はサイレント更新します。
     * 対話操作が必要な場合のみブラウザ認証を実行します。
     */
    async getIdToken(): Promise<string> {
        if (!this.tokenRequest) {
            this.tokenRequest = this.acquireIdToken().finally(() => {
                this.tokenRequest = undefined;
            });
        }
        return this.tokenRequest;
    }

    private isIdTokenValid(idToken: string): boolean {
        try {
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return false;
            }
            const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            return typeof claims === 'object' && claims !== null
                && 'exp' in claims && typeof claims.exp === 'number'
                && Number.isFinite(claims.exp)
                && claims.exp > Date.now() / 1000 + 60;
        } catch (error) {
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
            console.warn("AuthManager: Could not read cached ID token expiration.");
            return false;
        }
    }

    private async cacheIdToken(idToken: string): Promise<string> {
        if (!this.isIdTokenValid(idToken)) {
            throw new Error("Authentication returned an invalid or expired ID token.");
        }
        await this.context.secrets.store(this.idTokenCacheKey, idToken);
        return idToken;
    }

    private async acquireIdToken(): Promise<string> {
        // OIDC-only scopes do not guarantee an access token for MSAL's silent cache lookup.
        const cachedIdToken = await this.context.secrets.get(this.idTokenCacheKey);
        if (cachedIdToken) {
            if (this.isIdTokenValid(cachedIdToken)) {
                return cachedIdToken;
            }
            console.log("AuthManager: Cached ID token is expired or invalid. Attempting renewal.");
        }

        const tokenCache = this.clientApp.getTokenCache();
        const accounts = await tokenCache.getAllAccounts();

        console.log(`AuthManager: Found ${accounts.length} accounts in cache.`);

        // 1. ログイン済みの認証情報を使ってサイレント更新を試みる
        if (accounts.length > 0) {
            try {
                const silentRequest: msal.SilentFlowRequest = {
                    account: accounts[0],
                    scopes: this.scopes,
                    forceRefresh: true,
                };
                const result = await this.clientApp.acquireTokenSilent(silentRequest);
                if (result && result.idToken) {
                    console.log("AuthManager: Successfully acquired token silently.");
                    return await this.cacheIdToken(result.idToken);
                }
                throw new Error("Silent authentication returned no ID token.");
            } catch (error) {
                if (!(error instanceof msal.InteractionRequiredAuthError)) {
                    console.error("AuthManager: Silent token acquisition failed:", error);
                    throw error;
                }
                console.warn("AuthManager: Silent token acquisition failed. Error:", error);
            }
        } else {
            console.log("AuthManager: No accounts found in cache. Falling back to interactive flow.");
        }

        // 2. アカウントがない場合や対話操作が必要な場合のみブラウザ認証を実行
        try {
            const response = await this.clientApp.acquireTokenInteractive({
                scopes: this.scopes,
                openBrowser: async (url: string) => {
                    vscode.window.showInformationMessage('認証用のブラウザを開きます。ログインを行ってください。');
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
                    if (!opened) {
                        throw new Error("Could not open the authentication browser.");
                    }
                },
                successTemplate: '<h1>Authentication complete!</h1><p>You can close this tab and return to VS Code.</p>',
            });

            if (response && response.idToken) {
                console.log("AuthManager: Successfully acquired token interactively.");
                return await this.cacheIdToken(response.idToken);
            }
        } catch (error) {
            console.error("AuthManager: Interactive authentication failed:", error);
            throw new Error(`Interactive authentication failed: ${error}`);
        }

        throw new Error("Could not acquire ID token.");
    }
}
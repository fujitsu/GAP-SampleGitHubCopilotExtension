import * as msal from '@azure/msal-node';
import * as vscode from 'vscode';

const menloBlockMessage = 'Fujitsu-GAP: 認証通信が Menlo Security のポリシーで拒否されました（HTTP 403）。Windowsのプロキシ設定を確認し、VS Codeを再起動してください。';

class DiagnosticPublicClientApplication extends msal.PublicClientApplication {
    menloMetadataBlocked = false;

    constructor(configuration: msal.Configuration, metadataUrl: string) {
        super(configuration);
        const network = this.config.system.networkClient;
        const sendGet: msal.INetworkModule['sendGetRequestAsync'] =
            network.sendGetRequestAsync.bind(network);
        let lastNotification: { kind: 'menlo' | 'forbidden'; time: number } | undefined;
        network.sendGetRequestAsync = async <T>(
            url: string,
            options?: msal.NetworkRequestOptions,
            timeout?: number
        ): Promise<msal.NetworkResponse<T>> => {
            if (url !== metadataUrl) {
                return sendGet<T>(url, options, timeout);
            }

            try {
                const response = await sendGet<T>(url, options, timeout);
                const headers = Object.fromEntries(
                    Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])
                );
                const menloBlocked = response.status === 403
                    && (headers['x-menlo-disposition']?.trim().toLowerCase() === 'policy:blocked'
                        || headers['x-menlo-policy-action']?.trim().toLowerCase() === 'block');
                this.menloMetadataBlocked = menloBlocked;
                if (response.status === 403) {
                    const kind = menloBlocked ? 'menlo' : 'forbidden';
                    const now = Date.now();
                    if (lastNotification?.kind !== kind || now - lastNotification.time >= 60_000) {
                        lastNotification = { kind, time: now };
                        void vscode.window.showErrorMessage(menloBlocked
                            ? menloBlockMessage
                            : 'Fujitsu-GAP: 認証通信が拒否されました（HTTP 403）。Windowsのプロキシ設定を確認し、VS Codeを再起動してください。');
                    }
                } else if (response.status >= 200 && response.status < 300) {
                    lastNotification = undefined;
                }
                if (!vscode.workspace.getConfiguration('fujitsuGap').get<boolean>('verboseLogging', false)) {
                    return response;
                }
                const body: unknown = response.body;
                const required = ['authorization_endpoint', 'token_endpoint', 'issuer', 'jwks_uri'];
                const present = required.filter(key =>
                    typeof body === 'object' && body !== null
                    && Object.prototype.hasOwnProperty.call(body, key)
                );
                const contentType = Object.entries(response.headers)
                    .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
                const mediaType = contentType?.split(';')[0].trim().toLowerCase();
                const errorCode = typeof body === 'object' && body !== null && 'error' in body
                    && typeof body.error === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(body.error)
                    ? body.error : undefined;
                console.log('[Fujitsu-GAP MSAL HTTP] ' + JSON.stringify({
                    operation: 'openid-configuration',
                    status: response.status,
                    menloHeaders: {
                        dispositionPresent: Object.prototype.hasOwnProperty.call(headers, 'x-menlo-disposition'),
                        policyActionPresent: Object.prototype.hasOwnProperty.call(headers, 'x-menlo-policy-action')
                    },
                    menloBlocked,
                    contentType: mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
                        ? mediaType : 'unknown',
                    bodyType: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body,
                    present,
                    missing: required.filter(key => !present.includes(key)),
                    errorCode
                }));
                return response;
            } catch (error) {
                if (!vscode.workspace.getConfiguration('fujitsuGap').get<boolean>('verboseLogging', false)) {
                    throw error;
                }
                const code = typeof error === 'object' && error !== null && 'code' in error
                    && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
                    ? error.code : 'unknown';
                console.error(`[Fujitsu-GAP MSAL HTTP] openid-configuration request failed; code=${code}`);
                throw error;
            }
        };
    }
}

export class AuthManager {
    private clientApp: DiagnosticPublicClientApplication;
    private tenantName: string;
    private clientId: string;
    private context: vscode.ExtensionContext;
    private readonly scopes = ['openid', 'offline_access'];
    private tokenRequest: Promise<string> | undefined;
    private idToken: { value: string; expiresAt: number } | undefined;

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
            },
            system: {
                loggerOptions: {
                    logLevel: msal.LogLevel.Verbose,
                    piiLoggingEnabled: false,
                    loggerCallback: (level, message, containsPii) => {
                        if (containsPii || !vscode.workspace.getConfiguration('fujitsuGap').get<boolean>('verboseLogging', false)) {
                            return;
                        }

                        const text = `[Fujitsu-GAP MSAL] ${message}`;
                        if (level === msal.LogLevel.Error) {
                            console.error(text);
                        } else if (level === msal.LogLevel.Warning) {
                            console.warn(text);
                        } else {
                            console.log(text);
                        }
                    }
                }
            }
        };

        // Wrap MSAL's own transport so proxy, TLS, and response handling remain unchanged.
        this.clientApp = new DiagnosticPublicClientApplication(
            clientConfig,
            `${authority.toLowerCase()}/v2.0/.well-known/openid-configuration`
        );
    }

    /**
     * トークンを取得します。
     * メモリ内の有効な ID トークンを再利用します。
     * 未取得または期限切れの場合のみブラウザ認証を実行します。
     */
    async getIdToken(): Promise<string> {
        if (this.idToken && Date.now() < this.idToken.expiresAt) {
            return this.idToken.value;
        }
        this.idToken = undefined;
        if (!this.tokenRequest) {
            this.tokenRequest = this.acquireIdToken().finally(() => {
                this.tokenRequest = undefined;
            });
        }
        return this.tokenRequest;
    }

    private async acquireIdToken(): Promise<string> {
        this.clientApp.menloMetadataBlocked = false;
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
                // expiresOn describes the access token; use the ID token's own expiry.
                const claims = response.idTokenClaims;
                const expiresAt = claims && 'exp' in claims ? claims.exp : undefined;
                if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
                    || expiresAt <= Date.now() / 1000) {
                    throw new Error("Authentication returned an ID token with a missing, invalid, or expired expiry.");
                }
                this.idToken = { value: response.idToken, expiresAt: expiresAt * 1000 };
                console.log("AuthManager: Successfully acquired token interactively.");
                return response.idToken;
            }
            throw new Error("Could not acquire ID token.");
        } catch (error) {
            console.error("AuthManager: Interactive authentication failed:", error);
            this.throwIfMenloBlocked(error);
            throw new Error(`Interactive authentication failed: ${error}`);
        }
    }

    private throwIfMenloBlocked(error: unknown): void {
        if (this.clientApp.menloMetadataBlocked
            && error instanceof msal.ClientAuthError
            && error.errorCode === 'endpoints_resolution_error') {
            throw new Error(menloBlockMessage);
        }
    }
}
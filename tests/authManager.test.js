const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function createHarness(sendGetRequestAsync = async () => {}, context = {}) {
    let enabled;
    let configuration;
    let network;
    let now = 0;
    const logs = [];
    const notifications = [];
    const LogLevel = { Error: 0, Warning: 1, Info: 2, Verbose: 3 };
    const msal = {
        LogLevel,
        ClientAuthError: class ClientAuthError extends Error {
            constructor(code) { super(code); this.errorCode = code; }
        },
        InteractionRequiredAuthError: class InteractionRequiredAuthError extends Error {},
        PublicClientApplication: class {
            constructor(config) {
                configuration = config;
                network = { sendGetRequestAsync };
                this.config = { system: { networkClient: network } };
            }
        }
    };
    const vscode = {
        window: {
            showErrorMessage: (message) => { notifications.push(message); return Promise.resolve(); }
        },
        workspace: {
            getConfiguration: (section) => {
                assert.equal(section, 'fujitsuGap');
                return {
                    get: (key, defaultValue) => {
                        assert.equal(key, 'verboseLogging');
                        return enabled ?? defaultValue;
                    }
                };
            }
        }
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'authManager.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    });
    const exports = {};
    vm.runInNewContext(outputText, {
        exports,
        Date: { now: () => now },
        require: (id) => {
            if (id === '@azure/msal-node') return msal;
            if (id === 'vscode') return vscode;
            throw new Error(`Unexpected dependency: ${id}`);
        },
        console: Object.fromEntries(['error', 'warn', 'log'].map(
            (method) => [method, (text) => logs.push([method, text])]
        ))
    });
    const manager = new exports.AuthManager(context, 'example', 'client-id');
    return {
        logs,
        notifications,
        network,
        LogLevel,
        configuration,
        manager,
        msal,
        options: configuration.system.loggerOptions,
        setEnabled(value) { enabled = value; },
        advanceTime(milliseconds) { now += milliseconds; }
    };
}

test('Menlo metadata blocks reach the user through notification and authentication error', async () => {
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const response = { status: 403, headers: { 'x-menlo-policy-action': 'block' }, body: {} };
    const h = createHarness(async () => response);
    const client = h.manager.clientApp;
    client.acquireTokenInteractive = async () => {
        await h.network.sendGetRequestAsync(url);
        throw new h.msal.ClientAuthError('endpoints_resolution_error');
    };

    await assert.rejects(h.manager.getIdToken(), /Menlo Security.*HTTP 403/);
    assert.match(h.notifications[0], /Menlo Security.*HTTP 403/);

    response.headers = {};
    await assert.rejects(h.manager.getIdToken(), /Interactive authentication failed:.*endpoints_resolution_error/);
    assert.doesNotMatch(h.notifications[1], /Menlo/);

    response.headers = { 'x-menlo-disposition': 'policy:blocked' };
    await assert.rejects(h.manager.getIdToken(), /Menlo Security.*HTTP 403/);
});

test('a previous Menlo block does not replace later unrelated authentication errors', async () => {
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const h = createHarness(async () => ({
        status: 403, headers: { 'x-menlo-policy-action': 'block' }, body: {}
    }));
    const client = h.manager.clientApp;
    const failure = new h.msal.ClientAuthError('endpoints_resolution_error');
    client.acquireTokenInteractive = async () => { await h.network.sendGetRequestAsync(url); throw failure; };
    await assert.rejects(h.manager.getIdToken(), /Menlo Security/);
    client.acquireTokenInteractive = async () => { throw failure; };
    await assert.rejects(h.manager.getIdToken(), /Interactive authentication failed:.*endpoints_resolution_error/);
    client.acquireTokenInteractive = async () => {
        await h.network.sendGetRequestAsync(url);
        throw new h.msal.ClientAuthError('other_error');
    };
    await assert.rejects(h.manager.getIdToken(), /Interactive authentication failed:.*other_error/);
});

test('ID tokens are reused in memory until their own exact expiry without silent authentication', async () => {
    const h = createHarness();
    let calls = 0;
    h.manager.clientApp.acquireTokenInteractive = async () => ({
        idToken: `token-${++calls}`,
        idTokenClaims: { exp: calls * 60 },
        expiresOn: new Date(0)
    });

    assert.equal(await h.manager.getIdToken(), 'token-1');
    h.advanceTime(59_999);
    assert.equal(await h.manager.getIdToken(), 'token-1');
    assert.equal(calls, 1);
    h.advanceTime(1);
    assert.equal(await h.manager.getIdToken(), 'token-2');
    assert.equal(await h.manager.getIdToken(), 'token-2');
    assert.equal(calls, 2);

    const restarted = createHarness();
    restarted.manager.clientApp.acquireTokenInteractive = async () => ({
        idToken: 'new-session-token', idTokenClaims: { exp: 60 }
    });
    assert.equal(await restarted.manager.getIdToken(), 'new-session-token');
});

test('concurrent requests share authentication and failed authentication can be retried', async () => {
    const h = createHarness();
    let calls = 0;
    let finish;
    h.manager.clientApp.acquireTokenInteractive = () => {
        calls++;
        return new Promise(resolve => { finish = resolve; });
    };
    const requests = [h.manager.getIdToken(), h.manager.getIdToken()];
    assert.equal(calls, 1);
    finish({ idToken: 'shared-token', idTokenClaims: { exp: 60 } });
    assert.deepEqual(await Promise.all(requests), ['shared-token', 'shared-token']);

    h.advanceTime(60_000);
    h.manager.clientApp.acquireTokenInteractive = async () => { throw new Error('cancelled'); };
    await assert.rejects(h.manager.getIdToken(), /cancelled/);
    h.manager.clientApp.acquireTokenInteractive = async () => ({
        idToken: 'retried-token', idTokenClaims: { exp: 120 }
    });
    assert.equal(await h.manager.getIdToken(), 'retried-token');
});

test('missing tokens and invalid ID token expiries are reported and not cached', async () => {
    for (const response of [
        null, {}, { idToken: 'token' },
        ...[undefined, '60', NaN, Infinity, 0, -1].map(exp => ({
            idToken: 'token', idTokenClaims: { exp }
        }))
    ]) {
        const h = createHarness();
        h.manager.clientApp.acquireTokenInteractive = async () => response;
        await assert.rejects(h.manager.getIdToken(), /Interactive authentication failed/);
        assert.equal(h.logs.some(([level]) => level === 'error'), true);
        h.manager.clientApp.acquireTokenInteractive = async () => ({
            idToken: 'valid-token', idTokenClaims: { exp: 60 }
        });
        assert.equal(await h.manager.getIdToken(), 'valid-token');
    }
});

test('constructor initializes MSAL authority, client ID, and secret storage', async () => {
    const stored = new Map([['msal_token_cache', 'cached-msal-data']]);
    const h = createHarness(undefined, {
        secrets: {
            get: async key => stored.get(key),
            store: async (key, value) => { stored.set(key, value); }
        }
    });
    assert.equal(h.configuration.auth.clientId, 'client-id');
    assert.equal(h.configuration.auth.authority,
        'https://example.b2clogin.com/example.onmicrosoft.com/B2C_1_fjcloud_genai_susi');
    assert.deepEqual(Array.from(h.configuration.auth.knownAuthorities), ['example.b2clogin.com']);

    let deserialized;
    const cacheContext = {
        tokenCache: {
            deserialize: value => { deserialized = value; },
            serialize: () => 'updated-msal-data'
        },
        cacheHasChanged: true
    };
    await h.configuration.cache.cachePlugin.beforeCacheAccess(cacheContext);
    assert.equal(deserialized, 'cached-msal-data');
    await h.configuration.cache.cachePlugin.afterCacheAccess(cacheContext);
    assert.equal(stored.get('msal_token_cache'), 'updated-msal-data');
});

test('MSAL diagnostic logging is opt-in, live, and excludes PII', () => {
    const { logs, options, LogLevel, setEnabled } = createHarness();
    assert.equal(options.logLevel, LogLevel.Verbose);
    assert.equal(options.piiLoggingEnabled, false);

    options.loggerCallback(LogLevel.Verbose, 'off by default', false);
    assert.deepEqual(logs, []);
    setEnabled(true);
    options.loggerCallback(LogLevel.Verbose, 'metadata request', false);
    options.loggerCallback(LogLevel.Warning, 'warning', false);
    options.loggerCallback(LogLevel.Error, 'error', false);
    options.loggerCallback(LogLevel.Info, 'private', true);
    setEnabled(false);
    options.loggerCallback(LogLevel.Error, 'disabled again', false);
    assert.deepEqual(logs, [
        ['log', '[Fujitsu-GAP MSAL] metadata request'],
        ['warn', '[Fujitsu-GAP MSAL] warning'],
        ['error', '[Fujitsu-GAP MSAL] error']
    ]);
});

test('403 notifications identify Menlo only from block headers, even with verbose off', async () => {
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const response = { status: 403, headers: {}, body: {} };
    const h = createHarness(async () => response);
    assert.equal(await h.network.sendGetRequestAsync(url), response);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0], /HTTP 403/);
    assert.doesNotMatch(h.notifications[0], /Menlo/);
    response.headers = { 'X-Menlo-Disposition': 'policy:blocked' };
    await h.network.sendGetRequestAsync(url);
    assert.equal(h.notifications.length, 2);
    assert.match(h.notifications[1], /Menlo Security/);
    response.headers = { 'X-MENLO-POLICY-ACTION': ' BLOCK ' };
    await h.network.sendGetRequestAsync(url);
    assert.equal(h.notifications.length, 2);
    h.advanceTime(60_000);
    await h.network.sendGetRequestAsync(url);
    assert.equal(h.notifications.length, 3);
    response.status = 200;
    await h.network.sendGetRequestAsync(url);
    response.status = 403;
    await h.network.sendGetRequestAsync(url);
    assert.equal(h.notifications.length, 4);
    assert.deepEqual(h.logs, []);
});

test('unrelated requests and non-403 failures do not show block notifications', async () => {
    const h = createHarness(async () => ({
        status: 403, headers: { 'X-Menlo-Policy-Action': 'block' }, body: {}
    }));
    await h.network.sendGetRequestAsync('https://example.com/other');
    assert.deepEqual(h.notifications, []);
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const other = createHarness(async () => ({ status: 500, headers: {}, body: {} }));
    await other.network.sendGetRequestAsync(url);
    assert.deepEqual(other.notifications, []);
    const error = new Error('transport failed');
    const failed = createHarness(async () => { throw error; });
    await assert.rejects(failed.network.sendGetRequestAsync(url), e => e === error);
    assert.deepEqual(failed.notifications, []);
    assert.deepEqual(failed.logs, []);
});

test('metadata diagnostics preserve requests and responses, are opt-in, and omit secrets', async () => {
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const calls = [];
    const response = {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'set-cookie': 'secret-cookie' },
        body: { error: 'client_error', error_description: 'secret-body', access_token: 'secret-token' }
    };
    const h = createHarness(async (...args) => { calls.push(args); return response; });
    const options = { headers: { Authorization: 'secret-header' } };
    assert.equal(await h.network.sendGetRequestAsync(url, options, 123), response);
    assert.deepEqual(h.logs, []);
    h.setEnabled(true);
    assert.equal(await h.network.sendGetRequestAsync(url, options, 123), response);
    assert.deepEqual(calls, [[url, options, 123], [url, options, 123]]);
    const summary = JSON.parse(h.logs[0][1].slice('[Fujitsu-GAP MSAL HTTP] '.length));
    assert.equal(summary.status, 403);
    assert.equal(summary.contentType, 'text/html');
    assert.equal(summary.bodyType, 'object');
    assert.equal(summary.errorCode, 'client_error');
    assert.deepEqual(summary.missing, ['authorization_endpoint', 'token_endpoint', 'issuer', 'jwks_uri']);
    assert.equal(JSON.stringify(h.logs).includes('secret'), false);

    h.logs.length = 0;
    await h.network.sendGetRequestAsync('https://example.com/other', options);
    assert.deepEqual(h.logs, []);
    response.body = {
        authorization_endpoint: 'secret-url', token_endpoint: 'secret-url',
        issuer: 'secret-url', jwks_uri: 'secret-url', error: 'secret invalid error'
    };
    response.headers['Content-Type'] = 'secret invalid content-type';
    await h.network.sendGetRequestAsync(url);
    const valid = JSON.parse(h.logs[0][1].slice('[Fujitsu-GAP MSAL HTTP] '.length));
    assert.deepEqual(valid.missing, []);
    assert.equal(valid.present.length, 4);
    assert.equal(valid.contentType, 'unknown');
    assert.equal(valid.errorCode, undefined);
    assert.equal(JSON.stringify(h.logs).includes('secret'), false);
    h.setEnabled(false);
    h.logs.length = 0;
    await h.network.sendGetRequestAsync(url);
    assert.deepEqual(h.logs, []);
});

test('metadata diagnostics report Menlo header presence and block decisions without header values', async () => {
    const url = 'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration';
    const cases = [
        { status: 403, headers: {}, disposition: false, action: false, blocked: false },
        { status: 403, headers: { 'X-Menlo-Disposition': ' POLICY:BLOCKED ' }, disposition: true, action: false, blocked: true },
        { status: 403, headers: { 'X-MENLO-POLICY-ACTION': ' BLOCK ' }, disposition: false, action: true, blocked: true },
        { status: 403, headers: { 'x-menlo-disposition': '', 'x-menlo-policy-action': 'secret-value' }, disposition: true, action: true, blocked: false },
        { status: 200, headers: { 'x-menlo-policy-action': 'block' }, disposition: false, action: true, blocked: false }
    ];
    for (const entry of cases) {
        const h = createHarness(async () => ({ status: entry.status, headers: entry.headers, body: {} }));
        await h.network.sendGetRequestAsync(url);
        assert.deepEqual(h.logs, []);
        h.setEnabled(true);
        await h.network.sendGetRequestAsync(url);
        const summary = JSON.parse(h.logs[0][1].slice('[Fujitsu-GAP MSAL HTTP] '.length));
        assert.deepEqual(summary.menloHeaders, {
            dispositionPresent: entry.disposition,
            policyActionPresent: entry.action
        });
        assert.equal(summary.menloBlocked, entry.blocked);
        for (const value of Object.values(entry.headers).filter(Boolean)) {
            assert.equal(JSON.stringify(h.logs).includes(value), false);
        }
    }
});

test('metadata transport errors retain identity and log only a restricted code', async () => {
    const error = Object.assign(new Error('secret-url and secret-credentials'), { code: 'ENOTFOUND' });
    const h = createHarness(async () => { throw error; });
    h.setEnabled(true);
    await assert.rejects(h.network.sendGetRequestAsync(
        'https://example.b2clogin.com/example.onmicrosoft.com/b2c_1_fjcloud_genai_susi/v2.0/.well-known/openid-configuration'
    ), e => e === error);
    assert.deepEqual(h.logs, [
        ['error', '[Fujitsu-GAP MSAL HTTP] openid-configuration request failed; code=ENOTFOUND']
    ]);
});

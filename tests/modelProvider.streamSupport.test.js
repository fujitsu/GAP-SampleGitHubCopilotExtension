const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function harness(post, enabled = false) {
    class TextPart {
        constructor(value) { this.value = value; }
    }
    class ToolCallPart {
        constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
    }
    class ToolResultPart {}
    class CancellationError extends Error {}
    const vscode = {
        LanguageModelTextPart: TextPart,
        LanguageModelToolCallPart: ToolCallPart,
        LanguageModelToolResultPart: ToolResultPart,
        LanguageModelChatMessageRole: { Assistant: 2 },
        CancellationError,
        workspace: {
            getConfiguration: () => ({ get: () => enabled })
        }
    };
    const sources = {};
    function load(name) {
        if (sources[name]) return sources[name];
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.ts`), 'utf8');
        const output = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
        }).outputText;
        const exports = {};
        sources[name] = exports;
        vm.runInNewContext(output, {
            exports, Buffer, AbortController, console,
            require: id => {
                if (id === 'vscode') return vscode;
                if (id === 'axios') return { __esModule: true, default: { post } };
                if (id === './chatStreaming') return load('chatStreaming');
                if (id === './authManager') return {
                    AuthManager: class { async getIdToken() { return 'token'; } }
                };
                return require(id);
            }
        });
        return exports;
    }
    let callback;
    let disposed = false;
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(fn) {
            callback = fn;
            return { dispose() { disposed = true; } };
        }
    };
    return {
        provider: new (load('modelProvider').CustomModelProvider)({}, 'tenant', 'client', 100),
        token, vscode,
        cancel() { token.isCancellationRequested = true; callback(); },
        disposed: () => disposed,
        setEnabled(value) { enabled = value; }
    };
}

const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const done = 'data: [DONE]\r\n\r\n';
const delta = value => ({ choices: [{ index: 0, delta: value }] });

test('default response remains non-streaming and the setting applies on the next request', async () => {
    const requests = [];
    const h = harness(async (_url, body, config) => {
        requests.push({ body, config });
        if (body.stream) return {
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            data: Readable.from([Buffer.from(event(delta({ content: 'next' })) + done)])
        };
        return { data: { choices: [{ message: { content: 'complete' } }] } };
    });
    const results = [];
    const progress = { report: part => results.push(part.value) };
    assert.equal(await h.provider.provideLanguageModelChatResponse({}, [], {}, progress, h.token), undefined);
    h.setEnabled(true);
    await h.provider.provideLanguageModelChatResponse({}, [], {}, progress, h.token);
    assert.deepEqual(results, ['complete', 'next']);
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[1].body.stream, true);
    assert.equal(requests[1].config.responseType, 'stream');
    assert.equal(h.disposed(), true);
});

test('reports text incrementally and assembles interleaved tool calls across UTF-8 and SSE boundaries', async () => {
    const stream = new PassThrough();
    const h = harness(async () => ({ data: stream, headers: { 'content-type': 'text/event-stream' } }), true);
    const results = [];
    let first;
    const firstReport = new Promise(resolve => { first = resolve; });
    const response = h.provider.provideLanguageModelChatResponse({}, [], {}, {
        report(part) { results.push(part); first(); }
    }, h.token);
    const text = Buffer.from(event(delta({ content: 'こんにちは' })));
    const split = text.indexOf(Buffer.from('こ')) + 1;
    stream.write(text.subarray(0, split));
    stream.write(text.subarray(split));
    await firstReport;
    assert.equal(results[0].value, 'こんにちは');
    const chunks = [
        delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{"b":' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"a":1}' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] })
    ];
    stream.end(chunks.map(event).join('') + done);
    await response;
    assert.deepEqual(results.slice(1).map(part => [part.callId, part.name, part.input.a ?? part.input.b]),
        [['a', 'one', 1], ['b', 'two', 2]]);
});

test('handles SSE delimiters and UTF-8 characters split into individual bytes', async () => {
    const bytes = Buffer.from(event(delta({ content: '日本語' })) + done);
    const chunks = Array.from(bytes, byte => Buffer.from([byte]));
    const h = harness(async () => ({
        headers: { 'content-type': 'text/event-stream' }, data: Readable.from(chunks)
    }), true);
    const parts = [];
    await h.provider.provideLanguageModelChatResponse({}, [], {}, { report: part => parts.push(part.value) }, h.token);
    assert.deepEqual(parts, ['日本語']);
});

test('reports malformed or truncated streams and rejects non-event responses', async () => {
    for (const [body, contentType, message] of [
        [event(delta({ content: 'partial' })), 'text/event-stream', /before \[DONE\]/],
        ['data: not-json\n\n', 'text/event-stream', /JSON|Unexpected/],
        [event({ error: { message: 'failed' } }), 'text/event-stream', /Streaming API error/],
        [event(delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'tool' } }] })) + done,
            'text/event-stream', /incomplete tool call/],
        [event(delta({ content: 42 })) + done, 'text/event-stream', /expected a string/],
        ['{}', 'application/json', /Expected an OpenAI-compatible event stream/]
    ]) {
        const h = harness(async () => ({
            headers: { 'content-type': contentType }, data: Readable.from([Buffer.from(body)])
        }), true);
        await assert.rejects(h.provider.provideLanguageModelChatResponse({}, [], {}, { report() {} }, h.token), message);
        assert.equal(h.disposed(), true);
    }
});

test('preserves the authentication retry before any stream output', async () => {
    let calls = 0;
    const failed = new PassThrough();
    const h = harness(async () => {
        if (++calls === 1) throw { response: { status: 401, data: failed } };
        return {
            headers: { 'content-type': 'text/event-stream' },
            data: Readable.from([Buffer.from(event(delta({ content: 'ok' })) + done)])
        };
    }, true);
    const parts = [];
    await h.provider.provideLanguageModelChatResponse({}, [], {}, { report: part => parts.push(part.value) }, h.token);
    assert.equal(failed.destroyed, true);
    assert.equal(calls, 2);
    assert.deepEqual(parts, ['ok']);
});

test('cancellation aborts an in-progress request and disposes its listener', async () => {
    const stream = new PassThrough();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const h = harness(async (_url, _body, config) => {
        config.signal.addEventListener('abort', () => stream.destroy(new Error('aborted')));
        started();
        return { data: stream, headers: { 'content-type': 'text/event-stream' } };
    }, true);
    const response = h.provider.provideLanguageModelChatResponse({}, [], {}, { report() {} }, h.token);
    await ready;
    h.cancel();
    await assert.rejects(response, h.vscode.CancellationError);
    assert.equal(h.disposed(), true);
});

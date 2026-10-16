// __tests__/transport-edges.test.js
'use strict';
/**
 * lib/graphql.js and lib/http-get-json.js: the settle-once, close, aborted, deadline and
 * HTTP-status paths that poll-timeout.test.js and graphql.test.js do not reach. The fakes are
 * EventEmitters, and the tests emit the events Node's https module would, in the order it
 * would (data, end, then close; error and close on the request).
 */
const { EventEmitter } = require('events');

afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.unmock('https');
});

// A fake request and response. respond: false = the response callback is never called.
function fakeHttp(method, { respond = true, statusCode = 200, withDestroy = true, withSetTimeout = false } = {}) {
    const res = Object.assign(new EventEmitter(), { statusCode, headers: { 'content-type': 'application/json' }, complete: false, resume: jest.fn() });
    const req = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
    if (withDestroy) req.destroy = jest.fn();
    if (withSetTimeout) {
        req.setTimeout = jest.fn((ms, cb) => { req.timeoutCb = cb; return req; });
    }
    const mod = {
        [method]: jest.fn((...args) => {
            const cb = args.find((a) => typeof a === 'function');
            if (respond) cb(res);
            return req;
        }),
    };
    jest.doMock('https', () => mod);
    return { res, req, mod };
}

// Watch a promise without awaiting it.
function track(p) {
    const t = { state: 'pending', value: undefined };
    p.then((v) => { t.state = 'resolved'; t.value = v; }, (e) => { t.state = 'rejected'; t.value = e; });
    return t;
}

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('graphqlPost: events after it has settled', () => {
    test('a request error after a complete response is ignored', async () => {
        const { res, req } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":{"x":1}}');
        res.complete = true;
        res.emit('end');
        expect(() => req.emit('error', new Error('ECONNRESET'))).not.toThrow();
        await expect(p).resolves.toEqual(expect.objectContaining({ data: { data: { x: 1 } }, status: 200 }));
    });

    test('aborted and close after end (complete not yet set) do not turn a good answer into a failure', async () => {
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":');
        res.emit('data', '{"x":2}}');
        res.emit('end');
        res.emit('aborted');
        res.emit('close');
        await expect(p).resolves.toEqual(expect.objectContaining({ data: { data: { x: 2 } } }));
    });

    test('the response headers are passed back', async () => {
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":{}}');
        res.emit('end');
        const out = await p;
        expect(out.headers).toEqual({ 'content-type': 'application/json' });
    });

    test('a resolved request leaves no deadline timer behind', async () => {
        jest.useFakeTimers();
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        expect(jest.getTimerCount()).toBe(1);
        res.emit('data', '{"data":{}}');
        res.emit('end');
        await p;
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a parse failure leaves no deadline timer behind', async () => {
        jest.useFakeTimers();
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '<html>');
        res.emit('end');
        await expect(p).rejects.toThrow(/^Failed to parse API response/);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('graphqlPost: close and deadline once a response has started', () => {
    test('the request closing after the response started does not reject by itself; the 30 s deadline does', async () => {
        jest.useFakeTimers();
        const { res, req } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const t = track(graphqlPost({ query: '{ x }' }));
        res.emit('data', '{"da');
        req.emit('close');
        await flush();
        expect(t.state).toBe('pending');

        await jest.advanceTimersByTimeAsync(30000);
        expect(t.state).toBe('rejected');
        expect(t.value.message).toBe('Octopus API request timed out after 30s');
        expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    test('the socket idle timeout rejects once; a later close and the deadline change nothing', async () => {
        jest.useFakeTimers();
        const { req } = fakeHttp('request', { respond: false, withSetTimeout: true });
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        expect(req.setTimeout).toHaveBeenCalledWith(30000, expect.any(Function));
        req.timeoutCb();
        await expect(p).rejects.toThrow('Octopus API request timed out after 30s');
        req.emit('close');
        await jest.advanceTimersByTimeAsync(31000);
        expect(req.destroy).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a request with no destroy method still times out', async () => {
        jest.useFakeTimers();
        fakeHttp('request', { respond: false, withDestroy: false });
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        const check = expect(p).rejects.toThrow(/timed out after 30s/);
        await jest.advanceTimersByTimeAsync(30000);
        await check;
    });

    test('a request error before any response rejects with that error', async () => {
        const { req } = fakeHttp('request', { respond: false });
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        req.emit('error', new Error('getaddrinfo ENOTFOUND api.octopus.energy'));
        req.emit('close');
        await expect(p).rejects.toThrow('getaddrinfo ENOTFOUND api.octopus.energy');
    });
});

describe('graphqlPost: HTTP status', () => {
    function replyWith(statusCode, chunks) {
        const { res } = fakeHttp('request', { statusCode });
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        chunks.forEach((c) => res.emit('data', c));
        res.emit('end');
        return p;
    }

    test('an empty 502 body rejects with the status, not a parse error', async () => {
        const err = await replyWith(502, []).catch((e) => e);
        expect(err.message).toMatch(/^HTTP 502\b/);
        expect(err.message).not.toMatch(/parse/i);
    });

    test('a JSON null body on a 500 rejects with "HTTP 500"', async () => {
        await expect(replyWith(500, ['null'])).rejects.toThrow(/^HTTP 500$/);
    });

    test('a 503 whose errors field is not a list rejects with "HTTP 503"', async () => {
        await expect(replyWith(503, ['{"errors":"Service unavailable"}'])).rejects.toThrow(/^HTTP 503$/);
    });

    test('a 301 redirect page rejects with the status and a one-line snippet', async () => {
        const err = await replyWith(301, ['<html>\r\n  <body>Moved\tPermanently</body>\n</html>']).catch((e) => e);
        expect(err.message).toBe('HTTP 301: <html> <body>Moved Permanently</body> </html>');
    });

    test('a 500 that carries GraphQL errors resolves, so the Kraken code is kept', async () => {
        const out = await replyWith(500, ['{"data":null,"errors":[{"message":"Something went wrong.","extensions":{"errorCode":"KT-CT-1111"}}]}']);
        expect(out.status).toBe(500);
        expect(out.data.errors[0].extensions.errorCode).toBe('KT-CT-1111');
    });

    test('a 204 with an empty body is a parse failure (2xx is not an HTTP error)', async () => {
        await expect(replyWith(204, [])).rejects.toThrow(/^Failed to parse API response/);
    });

    test('a 199 informational status counts as an HTTP error', async () => {
        await expect(replyWith(199, ['{"detail":"x"}'])).rejects.toThrow(/^HTTP 199$/);
    });

    test('no status code at all is not treated as an HTTP error', async () => {
        const out = await replyWith(undefined, ['{"data":{"ok":true}}']);
        expect(out.data).toEqual({ data: { ok: true } });
        // graphqlPost reports a missing status code as 200; it is not an HTTP error either way.
        expect(out.status).toBe(200);
    });

    test('a body split across many chunks is joined before parsing', async () => {
        const json = JSON.stringify({ data: { devices: [{ id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES' }] } });
        const out = await replyWith(200, json.match(/.{1,3}/g));
        expect(out.data.data.devices[0].id).toBe('dev-1');
    });
});

describe('graphqlPost: request options', () => {
    test('no token: no Authorization header; the hostname can be changed; the timeout is 30 s', async () => {
        const { res, mod } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' }, undefined, 'api.backend.octopus.energy');
        res.emit('data', '{"data":{}}');
        res.emit('end');
        await p;
        const opts = mod.request.mock.calls[0][0];
        expect(opts.headers.Authorization).toBeUndefined();
        expect(opts.hostname).toBe('api.backend.octopus.energy');
        expect(opts.timeout).toBe(30000);
    });

    test('Content-Length counts bytes, not characters, and the body written is the JSON', async () => {
        const { res, req, mod } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const body = { query: '{ x }', variables: { note: '£5 – café' } };
        const p = graphqlPost(body, 'jwt');
        res.emit('data', '{"data":{}}');
        res.emit('end');
        await p;
        const payload = JSON.stringify(body);
        expect(mod.request.mock.calls[0][0].headers['Content-Length']).toBe(Buffer.byteLength(payload));
        expect(mod.request.mock.calls[0][0].headers['Content-Length']).toBeGreaterThan(payload.length);
        expect(req.write).toHaveBeenCalledWith(payload);
        expect(req.end).toHaveBeenCalledTimes(1);
    });

    test('exports the 30 s request timeout', () => {
        fakeHttp('request');
        expect(require('../lib/graphql').REQUEST_TIMEOUT_MS).toBe(30000);
    });
});

describe('httpGetJson: status, close and deadline', () => {
    test('a non-2xx reply drains the body, rejects once and leaves no timer', async () => {
        jest.useFakeTimers();
        const { res, req } = fakeHttp('get', { statusCode: 500 });
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/node-red-contrib-octopus-intelligent/latest');
        await expect(p).rejects.toThrow(/^HTTP 500$/);
        expect(res.resume).toHaveBeenCalledTimes(1);
        res.emit('close');
        req.emit('close');
        req.emit('error', new Error('late'));
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a 301 redirect is not followed: it rejects with "HTTP 301"', async () => {
        fakeHttp('get', { statusCode: 301 });
        const httpGetJson = require('../lib/http-get-json');
        await expect(httpGetJson('https://registry.npmjs.org/x')).rejects.toThrow(/^HTTP 301$/);
    });

    test('a request error after a good answer is ignored', async () => {
        const { res, req } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        res.emit('data', '{"version":"1.7.0"}');
        res.complete = true;
        res.emit('end');
        expect(() => req.emit('error', new Error('ECONNRESET'))).not.toThrow();
        await expect(p).resolves.toEqual({ version: '1.7.0' });
    });

    test('aborted and close after end do not turn a good answer into a failure', async () => {
        const { res } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        res.emit('data', '{"version":');
        res.emit('data', '"1.7.0"}');
        res.emit('end');
        res.emit('aborted');
        res.emit('close');
        await expect(p).resolves.toEqual({ version: '1.7.0' });
    });

    test('the request closing after the response started is left to the response and the deadline', async () => {
        jest.useFakeTimers();
        const { res, req } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const t = track(httpGetJson('https://registry.npmjs.org/x'));
        res.emit('data', '{"ver');
        req.emit('close');
        await flush();
        expect(t.state).toBe('pending');
        await jest.advanceTimersByTimeAsync(30000);
        expect(t.state).toBe('rejected');
        expect(t.value.message).toBe('Request timed out after 30s');
        expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    test('success and a parse failure both leave no deadline timer', async () => {
        jest.useFakeTimers();
        let f = fakeHttp('get');
        let httpGetJson = require('../lib/http-get-json');
        let p = httpGetJson('https://registry.npmjs.org/x');
        f.res.emit('data', '{}');
        f.res.emit('end');
        await expect(p).resolves.toEqual({});
        expect(jest.getTimerCount()).toBe(0);

        jest.resetModules();
        f = fakeHttp('get');
        httpGetJson = require('../lib/http-get-json');
        p = httpGetJson('https://registry.npmjs.org/x');
        f.res.emit('data', 'not json');
        f.res.emit('end');
        await expect(p).rejects.toThrow(/^JSON parse: /);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('the socket idle timeout rejects once and destroys the request', async () => {
        jest.useFakeTimers();
        const { req } = fakeHttp('get', { respond: false, withSetTimeout: true });
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        expect(req.setTimeout).toHaveBeenCalledWith(30000, expect.any(Function));
        req.timeoutCb();
        req.timeoutCb();
        await expect(p).rejects.toThrow('Request timed out after 30s');
        expect(req.destroy).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('passes the URL and a 30 s socket timeout to https.get', async () => {
        const { res, mod } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x/latest');
        res.emit('data', '{}');
        res.emit('end');
        await p;
        expect(mod.get).toHaveBeenCalledWith('https://registry.npmjs.org/x/latest', { timeout: 30000 }, expect.any(Function));
    });
});

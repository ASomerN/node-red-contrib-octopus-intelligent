// __tests__/poll-timeout.test.js
'use strict';
/**
 * Polls must never hang: request timeouts and an in-flight guard watchdog
 * (1.6.2). A request that never answers used to block every later poll.
 * These tests failed on 1.6.1.
 */

describe('F1: a request that never answers must not stop polling for ever', () => {
    afterEach(() => { jest.useRealTimers(); jest.resetModules(); jest.unmock('https'); });

    test('graphqlPost rejects when Octopus never answers', async () => {
        jest.useFakeTimers();
        jest.doMock('https', () => ({
            request: jest.fn(() => ({
                write: jest.fn(), end: jest.fn(), on: jest.fn(),
                setTimeout: jest.fn(function (ms, cb) { setTimeout(cb, ms); return this; }),
                destroy: jest.fn(),
            })),
        }));
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        const check = expect(p).rejects.toThrow(/timed out/);
        await jest.advanceTimersByTimeAsync(31000);
        await check;
        const req = require('https').request.mock.results[0].value;
        expect(req.destroy).toHaveBeenCalled();
    });

    test('httpGetJson rejects when the server never answers', async () => {
        jest.useFakeTimers();
        jest.doMock('https', () => ({
            get: jest.fn(() => ({
                on: jest.fn(),
                setTimeout: jest.fn(function (ms, cb) { setTimeout(cb, ms); return this; }),
                destroy: jest.fn(),
            })),
        }));
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        const check = expect(p).rejects.toThrow(/timed out/);
        await jest.advanceTimersByTimeAsync(31000);
        await check;
        const req = require('https').get.mock.results[0].value;
        expect(req.destroy).toHaveBeenCalled();
    });

    test('a tick that never settles does not block later ticks for ever', async () => {
        jest.useFakeTimers();
        const { wrapWithInFlightGuard } = require('../lib/scheduler');
        const fn = jest.fn()
            .mockImplementationOnce(() => new Promise(() => {})) // hangs
            .mockResolvedValue('ok');
        const guarded = wrapWithInFlightGuard(fn);
        guarded();
        await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
        await guarded();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('a response that stops part way must not hang the request (sweep 2026-10-08 #1)', () => {
    const { EventEmitter } = require('events');
    afterEach(() => { jest.useRealTimers(); jest.resetModules(); jest.unmock('https'); });

    // A fake request and response: the test emits the events Node would.
    function fakeHttp(method, { respond = true } = {}) {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, complete: false, resume: jest.fn() });
        const req = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn(), destroy: jest.fn() });
        jest.doMock('https', () => ({
            [method]: jest.fn((...args) => {
                const cb = args.find((a) => typeof a === 'function');
                if (respond) cb(res);
                return req;
            }),
        }));
        return { res, req };
    }

    test('graphqlPost rejects when the connection closes before the body ends', async () => {
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":');
        res.emit('aborted');
        res.emit('close');
        await expect(p).rejects.toThrow(/closed before the response completed/);
    });

    test('graphqlPost rejects when the response closes without aborted', async () => {
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":');
        res.emit('close');
        await expect(p).rejects.toThrow(/closed before the response completed/);
    });

    test('graphqlPost rejects when the request closes before any response', async () => {
        const { req } = fakeHttp('request', { respond: false });
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        req.emit('close');
        await expect(p).rejects.toThrow(/closed before/);
    });

    test('graphqlPost still resolves when close follows a complete response', async () => {
        const { res, req } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('data', '{"data":{"x":1}}');
        res.complete = true;
        res.emit('end');
        res.emit('close');
        req.emit('close');
        await expect(p).resolves.toEqual(expect.objectContaining({ data: { data: { x: 1 } } }));
    });

    test('graphqlPost gives up on a response that trickles in for longer than 30 s', async () => {
        jest.useFakeTimers();
        const { res, req } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        const check = expect(p).rejects.toThrow(/timed out/);
        for (let i = 0; i < 4; i++) {
            res.emit('data', ' ');            // a byte every 10 s keeps an idle timeout quiet
            await jest.advanceTimersByTimeAsync(10000);
        }
        await check;
        expect(req.destroy).toHaveBeenCalled();
    });

    test('graphqlPost settles once and leaves no deadline timer behind', async () => {
        jest.useFakeTimers();
        const { res } = fakeHttp('request');
        const { graphqlPost } = require('../lib/graphql');
        const p = graphqlPost({ query: '{ x }' });
        res.emit('close');
        await expect(p).rejects.toThrow(/closed before/);
        res.emit('data', '{}');
        res.emit('end');                      // a late end must not throw or settle again
        expect(jest.getTimerCount()).toBe(0);
    });

    test('httpGetJson rejects when the connection closes before the body ends', async () => {
        const { res } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        res.emit('data', '{"version":');
        res.emit('aborted');
        res.emit('close');
        await expect(p).rejects.toThrow(/closed before the response completed/);
    });

    test('httpGetJson rejects when the request closes before any response', async () => {
        const { req } = fakeHttp('get', { respond: false });
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        req.emit('close');
        await expect(p).rejects.toThrow(/closed before/);
    });

    test('httpGetJson gives up on a response that trickles in for longer than 30 s', async () => {
        jest.useFakeTimers();
        const { res, req } = fakeHttp('get');
        const httpGetJson = require('../lib/http-get-json');
        const p = httpGetJson('https://registry.npmjs.org/x');
        const check = expect(p).rejects.toThrow(/timed out/);
        for (let i = 0; i < 4; i++) {
            res.emit('data', ' ');
            await jest.advanceTimersByTimeAsync(10000);
        }
        await check;
        expect(req.destroy).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('F5: stopping the scheduler straight after start leaves nothing running', () => {
    afterEach(() => jest.useRealTimers());

    test('stop() inside the first second cancels the pending start', async () => {
        jest.useFakeTimers();
        const { createScheduler } = require('../lib/scheduler');
        const onTick = jest.fn(async () => {});
        const s = createScheduler(onTick);
        s.start();
        s.stop();
        await jest.advanceTimersByTimeAsync(5000);
        expect(onTick).not.toHaveBeenCalled();
    });
});


describe('the watchdog reports a stuck tick', () => {
    afterEach(() => jest.useRealTimers());

    test('onStuck is told how long the stuck tick has run', async () => {
        jest.useFakeTimers();
        const { wrapWithInFlightGuard } = require('../lib/scheduler');
        const onStuck = jest.fn();
        const fn = jest.fn()
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue('ok');
        const guarded = wrapWithInFlightGuard(fn, { maxMs: 60000, onStuck });
        guarded();
        await jest.advanceTimersByTimeAsync(30000);
        await guarded();                       // still inside maxMs: skipped quietly
        expect(fn).toHaveBeenCalledTimes(1);
        expect(onStuck).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(31000);
        await guarded();                       // past maxMs: runs again and reports
        expect(fn).toHaveBeenCalledTimes(2);
        expect(onStuck).toHaveBeenCalledWith(expect.any(Number));
        expect(onStuck.mock.calls[0][0]).toBeGreaterThanOrEqual(60000);
    });

    test('a late finish of the stuck tick does not unlock a newer tick early', async () => {
        jest.useFakeTimers();
        const { wrapWithInFlightGuard } = require('../lib/scheduler');
        let releaseFirst;
        const fn = jest.fn()
            .mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }))
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue('ok');
        const guarded = wrapWithInFlightGuard(fn, { maxMs: 60000 });
        guarded();
        await jest.advanceTimersByTimeAsync(61000);
        guarded();                             // second tick starts and hangs
        releaseFirst();                        // first tick finishes late
        await jest.advanceTimersByTimeAsync(1000);
        await guarded();                       // second is still in flight: skip
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('a superseded tick stops and is told so', () => {
    afterEach(() => jest.useRealTimers());

    test('the guard passes an isStale check that turns true once a newer tick starts', async () => {
        jest.useFakeTimers();
        const { wrapWithInFlightGuard } = require('../lib/scheduler');
        const seen = [];
        const fn = jest.fn((isStale) => { seen.push(isStale); return seen.length === 1 ? new Promise(() => {}) : Promise.resolve(); });
        const guarded = wrapWithInFlightGuard(fn, { maxMs: 60000 });
        guarded();
        expect(seen[0]()).toBe(false);
        await jest.advanceTimersByTimeAsync(61000);
        await guarded();
        expect(seen[0]()).toBe(true);
        expect(seen[1]()).toBe(false);
    });

    test('runTick stops polling categories once the tick is stale', async () => {
        const { runTick } = require('../lib/poll-tick');
        let stale = false;
        const a = { id: 'a', enabled: true, intervalMs: 1000, lastPolled: 0, poll: jest.fn(async () => { stale = true; return {}; }) };
        const b = { id: 'b', enabled: true, intervalMs: 1000, lastPolled: 0, poll: jest.fn(async () => ({})) };
        await runTick({ categories: [a, b], state: {}, getToken: async () => 't', isStale: () => stale });
        expect(a.poll).toHaveBeenCalledTimes(1);
        expect(b.poll).not.toHaveBeenCalled();
    });
});

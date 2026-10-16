'use strict';
jest.mock('https');
const https = require('https');
const httpGetJson = require('../lib/http-get-json');

describe('httpGetJson', () => {
    function mockResponse(statusCode, body) {
        return (url, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            const res = {
                statusCode,
                resume: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(body);
                    if (event === 'end') handler();
                }),
            };
            cb(res);
            return { on: jest.fn() };
        };
    }

    afterEach(() => { jest.resetAllMocks(); });

    it('resolves to parsed JSON on 200', async () => {
        https.get = mockResponse(200, '{"version":"1.4.0"}');
        await expect(httpGetJson('https://example.com/latest')).resolves.toEqual({ version: '1.4.0' });
    });

    it('rejects on 404', async () => {
        https.get = mockResponse(404, 'Not Found');
        await expect(httpGetJson('https://example.com/missing')).rejects.toThrow(/HTTP 404/);
    });

    it('rejects on 5xx', async () => {
        https.get = mockResponse(503, 'Service Unavailable');
        await expect(httpGetJson('https://example.com/down')).rejects.toThrow(/HTTP 503/);
    });

    it('rejects on invalid JSON', async () => {
        https.get = mockResponse(200, 'not valid json {');
        await expect(httpGetJson('https://example.com/bad')).rejects.toThrow(/JSON parse/);
    });

    it('rejects on network error', async () => {
        https.get = jest.fn(() => {
            const req = { on: jest.fn((event, handler) => { if (event === 'error') setTimeout(() => handler(new Error('ENOTFOUND')), 0); }) };
            return req;
        });
        await expect(httpGetJson('https://example.invalid/x')).rejects.toThrow(/ENOTFOUND/);
    });
});

// Review 2026-10-09 #4: the body was buffered with no size limit.
describe('httpGetJson — response size', () => {
    afterEach(() => { jest.resetAllMocks(); });

    test('a body over about 2 MB is cut off: the request is destroyed and it rejects', async () => {
        const mb = 'x'.repeat(1024 * 1024);
        const req = { on: jest.fn(), destroy: jest.fn() };
        https.get = jest.fn((url, opts, cb) => {
            const res = {
                statusCode: 200,
                resume: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') [mb, mb, mb].forEach((c) => handler(c));
                    if (event === 'end') handler();
                }),
            };
            process.nextTick(() => cb(res));
            return req;
        });
        await expect(httpGetJson('https://example.com/huge')).rejects.toThrow(/^Response too large$/);
        expect(req.destroy).toHaveBeenCalled();
    });
});

// Review 2026-10-09 #5: a 200 body that parses to null, a string or a list must reject.
describe('httpGetJson — response shape', () => {
    afterEach(() => { jest.resetAllMocks(); });

    function reply(body) {
        https.get = jest.fn((url, opts, cb) => {
            const res = {
                statusCode: 200,
                resume: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(body);
                    if (event === 'end') handler();
                }),
            };
            cb(res);
            return { on: jest.fn() };
        });
    }

    test.each([['null'], ['"1.6.2"'], ['[]']])('a 200 body of %s rejects with "Unexpected response shape"', async (body) => {
        reply(body);
        await expect(httpGetJson('https://example.com/latest')).rejects.toThrow(/^Unexpected response shape$/);
    });
});

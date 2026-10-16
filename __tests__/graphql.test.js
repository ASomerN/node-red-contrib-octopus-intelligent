'use strict';
const https = require('https');

jest.mock('https');

const { graphqlPost } = require('../lib/graphql');

describe('graphqlPost', () => {
    beforeEach(() => jest.clearAllMocks());

    test('makes POST request to Octopus GraphQL endpoint', async () => {
        const mockRes = {
            statusCode: 200,
            headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') cb('{"data":{"foo":"bar"}}');
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
        https.request.mockImplementation((opts, cb) => { cb(mockRes); return mockReq; });

        const result = await graphqlPost({ query: '{ foo }' });
        expect(result.data).toEqual({ data: { foo: 'bar' } });
        expect(result.status).toBe(200);
        expect(https.request).toHaveBeenCalledWith(
            expect.objectContaining({
                hostname: 'api.octopus.energy',
                path: '/v1/graphql/',
                method: 'POST'
            }),
            expect.any(Function)
        );
    });

    test('includes Authorization header when token provided', async () => {
        const mockRes = {
            statusCode: 200, headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') cb('{"data":{}}');
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
        https.request.mockImplementation((opts, cb) => { cb(mockRes); return mockReq; });

        await graphqlPost({ query: '{ foo }' }, 'my-token');
        const callOpts = https.request.mock.calls[0][0];
        expect(callOpts.headers['Authorization']).toBe('my-token');
        expect(callOpts.headers['User-Agent']).toMatch(/^node-red-contrib-octopus-intelligent\//);
    });

    test('rejects when response JSON is invalid', async () => {
        const mockRes = {
            statusCode: 200, headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') cb('not-json');
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
        https.request.mockImplementation((opts, cb) => { cb(mockRes); return mockReq; });

        await expect(graphqlPost({ query: '{ foo }' })).rejects.toThrow('Failed to parse API response');
    });
});

// Sweep 2026-10-08 #8: a gateway or rate-limit reply must say "HTTP 503" / "HTTP 429",
// not "Unexpected token '<'" or "Response missing data".
describe('graphqlPost — HTTP status', () => {
    beforeEach(() => jest.clearAllMocks());

    function reply(statusCode, body) {
        const mockRes = {
            statusCode, headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') cb(body);
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
        https.request.mockImplementation((opts, cb) => { cb(mockRes); return mockReq; });
    }

    test('an HTML 503 page rejects with the status and a short snippet', async () => {
        reply(503, '<html>\n<head><title>503 Service Temporarily Unavailable</title></head>' + 'x'.repeat(500) + '</html>');
        const err = await graphqlPost({ query: '{ foo }' }).catch((e) => e);
        expect(err.message).toMatch(/^HTTP 503: <html> <head><title>503 Service Temporarily Unavailable/);
        expect(err.message.length).toBeLessThan(120);
    });

    test('a JSON 429 with no GraphQL errors rejects with "HTTP 429"', async () => {
        reply(429, '{"detail":"Request was throttled."}');
        await expect(graphqlPost({ query: '{ foo }' })).rejects.toThrow(/^HTTP 429$/);
    });

    test('a non-2xx reply that carries GraphQL errors still resolves, so the Kraken error code is kept', async () => {
        reply(400, '{"errors":[{"message":"Invalid data.","extensions":{"errorCode":"KT-CT-4321"}}]}');
        const result = await graphqlPost({ query: '{ foo }' });
        expect(result.status).toBe(400);
        expect(result.data.errors[0].extensions.errorCode).toBe('KT-CT-4321');
    });

    test('a 200 reply is unchanged', async () => {
        reply(200, '{"data":{"foo":1}}');
        await expect(graphqlPost({ query: '{ foo }' })).resolves.toEqual(expect.objectContaining({ data: { data: { foo: 1 } }, status: 200 }));
    });
});

// Review 2026-10-09 #4: the body was buffered with no size limit, and snippet() scanned all of it.
describe('graphqlPost — response size', () => {
    const { snippet, MAX_RESPONSE_BYTES } = require('../lib/graphql');
    beforeEach(() => jest.clearAllMocks());

    function streamed(chunks, statusCode = 200) {
        const mockRes = {
            statusCode, headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') chunks.forEach((c) => cb(c));
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn(), destroy: jest.fn() };
        // The response arrives after https.request has returned, as it does for real.
        https.request.mockImplementation((opts, cb) => { process.nextTick(() => cb(mockRes)); return mockReq; });
        return mockReq;
    }

    test('a body over about 2 MB is cut off: the request is destroyed and it rejects', async () => {
        const mb = 'x'.repeat(1024 * 1024);
        const req = streamed([mb, mb, mb]);
        await expect(graphqlPost({ query: '{ foo }' })).rejects.toThrow(/^Octopus API response too large$/);
        expect(req.destroy).toHaveBeenCalled();
    });

    test('a large body under the limit is still read', async () => {
        const padding = 'a'.repeat(512 * 1024);
        streamed(['{"data":{"pad":"', padding, '"}}']);
        const result = await graphqlPost({ query: '{ foo }' });
        expect(result.data.data.pad).toHaveLength(512 * 1024);
    });

    test('the limit is about 2 MB', () => {
        expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    });

    test('snippet looks only at the start of the body', () => {
        expect(snippet('a' + ' \n'.repeat(5000) + 'b')).toBe('a');
        expect(snippet('<html>\n  <body>Bad   Gateway</body>')).toBe('<html> <body>Bad Gateway</body>');
    });
});

// Review 2026-10-09 #5: a 2xx body that parses to null, a string or a list resolved, and every
// caller then threw "Cannot read properties of null (reading 'errors')".
describe('graphqlPost — response shape', () => {
    beforeEach(() => jest.clearAllMocks());

    function reply(body) {
        const mockRes = {
            statusCode: 200, headers: {},
            on: jest.fn((event, cb) => {
                if (event === 'data') cb(body);
                if (event === 'end') cb();
            })
        };
        const mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
        https.request.mockImplementation((opts, cb) => { cb(mockRes); return mockReq; });
    }

    test.each([['null'], ['"maintenance"'], ['[]'], ['42']])('a 200 body of %s rejects with a clear error', async (body) => {
        reply(body);
        const err = await graphqlPost({ query: '{ foo }' }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe(`Unexpected response shape: ${body}`);
    });

    test('a GraphQL errors-only body is still an answer', async () => {
        reply('{"errors":[{"message":"Unauthorized.","extensions":{"errorCode":"KT-CT-1111"}}]}');
        const result = await graphqlPost({ query: '{ foo }' });
        expect(result.data.errors[0].extensions.errorCode).toBe('KT-CT-1111');
    });
});

// Network sweep F8: Retry-After as delay seconds or an HTTP date.
describe('retryAfterMs', () => {
    const { retryAfterMs } = jest.requireActual('../lib/graphql');
    test('seconds, an HTTP date, or null', () => {
        expect(retryAfterMs('120')).toBe(120000);
        expect(retryAfterMs(' 0 ')).toBe(0);
        const now = Date.parse('2026-09-30T01:00:00Z');
        expect(retryAfterMs('Wed, 30 Sep 2026 01:02:00 GMT', now)).toBe(120000);
        expect(retryAfterMs('Wed, 30 Sep 2026 00:59:00 GMT', now)).toBe(0);
        expect(retryAfterMs(undefined)).toBeNull();
        expect(retryAfterMs('soon')).toBeNull();
    });
});

'use strict';
jest.mock('https');
const https = require('https');
const httpGetJson = require('../lib/http-get-json');

describe('httpGetJson', () => {
    function mockResponse(statusCode, body) {
        return (url, cb) => {
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

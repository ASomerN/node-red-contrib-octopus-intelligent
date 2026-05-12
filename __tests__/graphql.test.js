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

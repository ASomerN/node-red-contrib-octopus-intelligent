'use strict';
jest.mock('../lib/graphql');
const { graphqlPost } = require('../lib/graphql');
const { obtainToken } = require('../lib/auth');

describe('obtainToken', () => {
    test('returns token on success', async () => {
        graphqlPost.mockResolvedValue({
            status: 200,
            data: { data: { obtainKrakenToken: { token: 'abc123' } } }
        });
        const token = await obtainToken('my-api-key');
        expect(token).toBe('abc123');
        expect(graphqlPost).toHaveBeenCalledWith(
            expect.objectContaining({ variables: { input: { APIKey: 'my-api-key' } } })
        );
    });

    test('throws when API returns errors', async () => {
        graphqlPost.mockResolvedValue({
            status: 200,
            data: { errors: [{ message: 'Invalid API key' }] }
        });
        await expect(obtainToken('bad-key')).rejects.toThrow('Auth failed');
    });

    test('throws when token missing from response', async () => {
        graphqlPost.mockResolvedValue({ status: 200, data: { data: {} } });
        await expect(obtainToken('key')).rejects.toThrow('Auth response missing token');
    });
});

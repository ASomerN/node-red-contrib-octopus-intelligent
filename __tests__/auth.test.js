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

// Adversarial review A12: a GraphQL server can echo the APIKey variable in an input error.
describe('obtainToken error text keeps the API key Octopus echoed', () => {
    test('an echoed key is in the error, so a wrong key can be seen', async () => {
        const key = 'sk_live_AbCdEf0123456789ZyXw';
        graphqlPost.mockResolvedValue({
            status: 200,
            data: { errors: [{ message: `Variable '$input' got invalid value {'APIKey': '${key}'}; Field 'APIKey' is not defined` }] },
        });
        const err = await obtainToken(key).catch((e) => e);
        expect(err.message).toMatch(/^Auth failed/);
        expect(err.message).toContain(key);
    });
});

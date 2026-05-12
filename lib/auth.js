'use strict';
const { graphqlPost } = require('./graphql');

async function obtainToken(apiKey) {
    const response = await graphqlPost({
        query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) {
            obtainKrakenToken(input: $input) { token }
        }`,
        variables: { input: { APIKey: apiKey } }
    });
    if (response.data.errors) {
        throw new Error(`Auth failed: ${JSON.stringify(response.data.errors)}`);
    }
    if (!response.data.data || !response.data.data.obtainKrakenToken) {
        throw new Error('Auth response missing token data');
    }
    return response.data.data.obtainKrakenToken.token;
}

module.exports = { obtainToken };

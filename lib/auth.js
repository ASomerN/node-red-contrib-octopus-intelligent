'use strict';
const { graphqlPost } = require('./graphql');
const { truncate } = require('./graphql-errors');

const MAX_RAW_ERROR_LENGTH = 8192;

async function obtainToken(apiKey) {
    const response = await graphqlPost({
        query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) {
            obtainKrakenToken(input: $input) { token }
        }`,
        variables: { input: { APIKey: apiKey } }
    });
    if (response.data.errors) {
        // Kraken can echo the APIKey variable in an input error. Shown as it is in Node-RED, so a
        // wrong key can be seen; masked only when published to Home Assistant.
        throw new Error(truncate(`Auth failed: ${JSON.stringify(response.data.errors)}`, MAX_RAW_ERROR_LENGTH));
    }
    if (!response.data.data || !response.data.data.obtainKrakenToken) {
        throw new Error('Auth response missing token data');
    }
    return response.data.data.obtainKrakenToken.token;
}

module.exports = { obtainToken };

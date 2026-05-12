'use strict';
const https = require('https');
const { version } = require('../package.json');

// User-Agent is REQUIRED for api.backend.octopus.energy — the default Node.js UA
// is blocked at the edge (403). Sending a real UA on every request keeps both
// the main and backend endpoints reachable from a single transport.
const USER_AGENT = `node-red-contrib-octopus-intelligent/${version}`;

function graphqlPost(body, token, hostname = 'api.octopus.energy') {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': USER_AGENT
        };
        // Kraken expects the raw JWT. Both endpoints accept this. Adding a
        // "JWT " prefix passes main-endpoint validation but fails sub-resolver
        // auth on api.backend.octopus.energy (verified live 2026-05-11).
        if (token) headers['Authorization'] = token;
        const req = https.request({
            hostname,
            path: '/v1/graphql/',
            method: 'POST',
            headers
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve({ data: JSON.parse(raw), status: res.statusCode, headers: res.headers });
                } catch (e) {
                    reject(new Error('Failed to parse API response: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

module.exports = { graphqlPost };

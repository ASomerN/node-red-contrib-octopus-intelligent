'use strict';
const https = require('https');

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
            });
        });
        req.on('error', reject);
    });
}

module.exports = httpGetJson;

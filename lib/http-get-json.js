'use strict';
const https = require('https');

// Idle timeout for the socket, and also the most a whole request may take.
const REQUEST_TIMEOUT_MS = 30000;
// The npm registry answer is a few kilobytes; a body past this is cut off and fails.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        // Settle exactly once: error, close, timeout and end can all arrive for one request.
        let settled = false;
        let deadline = null;
        let req = null;
        let gotResponse = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            if (deadline) clearTimeout(deadline);
            fn(value);
        };
        const fail = (err) => settle(reject, err);
        const timedOut = () => {
            if (settled) return;
            if (req && typeof req.destroy === 'function') req.destroy();
            fail(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
        };
        // Set before the request: a mocked or very fast response can settle synchronously.
        deadline = setTimeout(timedOut, REQUEST_TIMEOUT_MS);
        req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, res => {
            gotResponse = true;
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return fail(new Error(`HTTP ${res.statusCode}`));
            }
            let body = '';
            let bytes = 0;
            let ended = false;
            res.on('data', (chunk) => {
                if (settled) return;
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    if (req && typeof req.destroy === 'function') req.destroy();
                    fail(new Error('Response too large'));
                    return;
                }
                body += chunk;
            });
            res.on('end', () => {
                ended = true;
                if (settled) return;
                let data;
                try { data = JSON.parse(body); }
                catch (e) { return fail(new Error(`JSON parse: ${e.message}`)); }
                // Callers read fields off the answer: null, a string or a list is not one.
                if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                    return fail(new Error('Unexpected response shape'));
                }
                settle(resolve, data);
            });
            // A connection closed part way through the body gives no 'end' and no 'error'.
            const closedEarly = () => {
                if (!ended && !res.complete) fail(new Error('Connection closed before the response completed'));
            };
            res.on('aborted', closedEarly);
            res.on('close', closedEarly);
        });
        req.on('error', fail);
        // Once a response has started, its own close handling above decides.
        req.on('close', () => {
            if (!gotResponse) fail(new Error('Connection closed before a response arrived'));
        });
        if (typeof req.setTimeout === 'function') {
            req.setTimeout(REQUEST_TIMEOUT_MS, timedOut);
        }
    });
}

module.exports = httpGetJson;
module.exports.MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES;

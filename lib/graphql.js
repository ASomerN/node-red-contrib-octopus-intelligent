'use strict';
const https = require('https');
const { version } = require('../package.json');

// User-Agent is REQUIRED for api.backend.octopus.energy — the default Node.js UA
// is blocked at the edge (403). Sending a real UA on every request keeps both
// the main and backend endpoints reachable from a single transport.
const USER_AGENT = `node-red-contrib-octopus-intelligent/${version}`;

// A request with no answer must fail, not hang: a hung poll blocks every later poll.
// The socket timeout below is an idle timeout; REQUEST_TIMEOUT_MS is also the most a
// whole request may take, so a response that trickles in is cut off too.
const REQUEST_TIMEOUT_MS = 30000;

// The deadline bounds time, not size. Kraken's real answers are tens of kilobytes; a body
// past this (an error page served in a loop, a misrouted proxy) is cut off and fails.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// The start of a body that isn't JSON (e.g. an HTML error page), on one line. Only the first
// kilobyte is looked at, however long the body is.
function snippet(raw) {
    return String(raw).slice(0, 1024).replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Retry-After (RFC 9110): delay seconds or an HTTP date. In ms, or null when absent or unreadable.
function retryAfterMs(value, nowMs = Date.now()) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const at = Date.parse(s);
    return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

// An HTTP error reply. A rate limit (429) or outage (503) can say when to try again:
// err.retryAfterMs carries it for the caller's back-off.
function httpError(message, status, headers) {
    const err = new Error(message);
    err.status = status;
    const wait = retryAfterMs(headers && headers['retry-after']);
    if (wait !== null) err.retryAfterMs = wait;
    return err;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function graphqlPost(body, token, hostname = 'api.octopus.energy') {
    return new Promise((resolve, reject) => {
        // Settle exactly once: error, close, timeout and end can all arrive for one request.
        let settled = false;
        let deadline = null;
        let req = null;
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
            fail(new Error(`Octopus API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
        };

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
        let gotResponse = false;
        // Set before the request: a mocked or very fast response can settle synchronously.
        deadline = setTimeout(timedOut, REQUEST_TIMEOUT_MS);
        req = https.request({
            hostname,
            path: '/v1/graphql/',
            method: 'POST',
            headers,
            timeout: REQUEST_TIMEOUT_MS   // also covers DNS and connecting
        }, (res) => {
            gotResponse = true;
            let raw = '';
            let bytes = 0;
            let ended = false;
            res.on('data', (chunk) => {
                if (settled) return;
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    if (req && typeof req.destroy === 'function') req.destroy();
                    fail(new Error('Octopus API response too large'));
                    return;
                }
                raw += chunk;
            });
            res.on('end', () => {
                ended = true;
                if (settled) return;
                const status = res.statusCode;
                // A gateway, rate-limit or outage reply: say so ("HTTP 503"), unless it carries
                // GraphQL errors, which callers read for the Kraken error code.
                const notOk = typeof status === 'number' && (status < 200 || status >= 300);
                let data;
                try {
                    data = JSON.parse(raw);
                } catch (e) {
                    if (notOk) return fail(httpError(`HTTP ${status}: ${snippet(raw)}`, status, res.headers));
                    return fail(new Error('Failed to parse API response: ' + e.message));
                }
                if (notOk && !(data && Array.isArray(data.errors))) return fail(httpError(`HTTP ${status}`, status, res.headers));
                // Callers read data.errors and data.data: a body of null, a string or a list is
                // not a GraphQL answer and would only fail later with a TypeError.
                if (!isPlainObject(data)) return fail(new Error(`Unexpected response shape: ${snippet(raw)}`));
                settle(resolve, { data, status, headers: res.headers });
            });
            // A connection closed part way through the body gives no 'end' and no 'error'.
            const closedEarly = () => {
                if (!ended && !res.complete) fail(new Error('Octopus API connection closed before the response completed'));
            };
            res.on('aborted', closedEarly);
            res.on('close', closedEarly);
        });
        req.on('error', fail);
        // Once a response has started, its own close handling above decides.
        req.on('close', () => {
            if (!gotResponse) fail(new Error('Octopus API connection closed before a response arrived'));
        });
        if (typeof req.setTimeout === 'function') {
            req.setTimeout(REQUEST_TIMEOUT_MS, timedOut);
        }
        req.write(payload);
        req.end();
    });
}

module.exports = { graphqlPost, snippet, retryAfterMs, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES };

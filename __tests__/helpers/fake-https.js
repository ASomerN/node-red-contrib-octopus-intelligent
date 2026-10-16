// __tests__/helpers/fake-https.js
'use strict';
/**
 * A fake `https` module for network-level tests. The REAL lib/graphql.js and
 * lib/http-get-json.js run on top of it, so every failure reaches the node the way Node's
 * https module would deliver it: HTML gateway pages, rate limits, a reset part way through
 * the body, DNS failures, a request that never answers, malformed bodies, a callback that
 * fires twice.
 *
 * In a test file (jest hoists this above the requires):
 *
 *   jest.mock('https', () => require('./helpers/fake-https').createFakeHttps());
 *   const net = require('https').__net;
 *
 * Each request is recorded in net.calls as { op, host, body, startedAt, endedAt, outcome }.
 * `op` is the GraphQL operation name (obtainToken, discover, getDevices, getDispatches,
 * setPreferences, UpdateSmartControl, SetChargeCap, getAccountBalance, ...), except:
 *   getDevicesStatus          the getDevices query without preferences (startup device fetch,
 *                             smart charging verification)
 *   getApplicableRatesExport  getApplicableRates for the export MPAN (EXPORT_MPAN)
 *   npm                       the update check (https.get)
 *
 * A request is answered with net.replies[op](call) (a JSON body), unless a gate from
 * net.hold(op) or a rule from net.fail(op, mode, { times, when }) applies. Answers are
 * delivered after the caller has attached its listeners, as Node does. Fake timers apply:
 * the idle timeout set with req.setTimeout() fires as Node's socket timeout would.
 */
const { EventEmitter } = require('events');

// Secrets that must never be published to Home Assistant. The Node-RED log, status and msg show them.
const KEY = 'sk_live_AbCdEf0123456789ZyXw';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXZhbHVl';
const EXPORT_MPAN = 'MPAN-EXP';
// A Kraken error message of about 21 kB that echoes the API key and the token.
const LONG_MESSAGE = `Invalid input ${KEY} token ${JWT}. ${'detail '.repeat(3000)}`;

const html = (title) => `<html>\r\n<head><title>${title}</title></head>\r\n<body>\r\n<center><h1>${title}</h1></center>\r\n`
    + '<hr><center>cloudflare</center>\r\n</body>\r\n</html>\r\n';

/**
 * Failure modes. For each: what lib/graphql.js does with it (rejects or resolves with the
 * body), whether lib/graphql-errors isNetworkError() calls it a network failure (the
 * "Octopus is down" breaker in lib/poll-tick.js), how long it takes (latency, ms), the text
 * a GraphQL caller's error carries (text; null when it depends on the caller), and the
 * update check's update_check_error text (npm).
 */
const MODES = {
    http500: { rejects: true, network: true, text: /HTTP 500/, npm: /HTTP 500/ },
    http502: { rejects: true, network: true, text: /HTTP 502/, npm: /HTTP 502/ },
    http503: { rejects: true, network: true, text: /HTTP 503/, npm: /HTTP 503/ },
    http504: { rejects: true, network: true, text: /HTTP 504/, npm: /HTTP 504/ },
    http429: { rejects: true, network: false, text: /HTTP 429/, npm: /HTTP 429/ },
    // A JSON 401 with a Kraken error: graphqlPost resolves so the caller can read the code.
    http401: { rejects: false, network: false, gqlErrors: true, text: /KT-CT-1139/, npm: /HTTP 401/ },
    http403: { rejects: true, network: false, text: /HTTP 403/, npm: /HTTP 403/ },
    resetMidBody: { rejects: true, network: true, text: /closed before the response completed/, npm: /closed before the response completed/ },
    econnreset: { rejects: true, network: true, text: /ECONNRESET/, npm: /ECONNRESET/ },
    enotfound: { rejects: true, network: true, text: /ENOTFOUND/, npm: /ENOTFOUND/ },
    etimedout: { rejects: true, network: true, text: /ETIMEDOUT/, npm: /ETIMEDOUT/ },
    // No answer at all: the 30 s idle timeout and the 30 s overall deadline.
    hang: { rejects: true, network: true, latency: 30000, text: /timed out after 30s/, npm: /timed out after 30s/ },
    // Headers, then a byte every 10 s: the idle timeout never fires, the overall deadline does.
    trickle: { rejects: true, network: true, latency: 30000, text: /timed out after 30s/, npm: /timed out after 30s/ },
    empty: { rejects: true, network: false, text: /Failed to parse API response/, npm: /JSON parse/ },
    badjson: { rejects: true, network: false, text: /Failed to parse API response/, npm: /JSON parse/ },
    jsonNull: { rejects: false, network: false, text: null, npm: /npm registry response missing version/ },
    emptyObject: { rejects: false, network: false, text: null, npm: /npm registry response missing version/ },
    dataNull: { rejects: false, network: false, text: null, npm: /npm registry response missing version/ },
    errorsNoExt: { rejects: false, network: false, gqlErrors: true, text: /Something went wrong/, npm: /npm registry response missing version/ },
    errorsLong: { rejects: false, network: false, gqlErrors: true, text: /Invalid input sk_live_AbCdEf0123456789ZyXw token eyJhbGciOiJIUzI1NiJ9/, npm: /npm registry response missing version/ },
};
const FAILURE_MODES = Object.keys(MODES);

function opName(kind, body) {
    if (kind === 'get') return 'npm';
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return 'unparsed'; }
    const query = String((parsed && parsed.query) || '');
    const m = query.match(/\b(?:query|mutation)\s+(\w+)/);
    let name = m ? m[1] : 'unknown';
    if (name === 'getDevices' && !/SmartFlexDevicePreferences/.test(query)) name = 'getDevicesStatus';
    if (name === 'getApplicableRates' && parsed.variables && parsed.variables.mpxn === EXPORT_MPAN) name = 'getApplicableRatesExport';
    return name;
}

function createFakeHttps() {
    const net = { calls: [], rules: [], holds: [], replies: {} };

    net.reset = () => {
        net.calls = [];
        net.rules = [];
        net.holds = [];
        net.replies = {};
    };

    // Answer requests for `op` with `mode` (`times` requests at most; only those `when` accepts).
    net.fail = (op, mode, { times = Infinity, when = null } = {}) => {
        const rule = { op, mode, times, when, used: 0 };
        net.rules.push(rule);
        return rule;
    };

    net.clearRules = () => { net.rules = []; };

    // The next request for `op` waits until gate.release(mode) (default: a good answer).
    net.hold = (op) => {
        const gate = { op, call: null, mode: null };
        gate.release = (mode = 'ok') => {
            gate.mode = mode;
            if (gate.call) run(gate.call, mode);
        };
        net.holds.push(gate);
        return gate;
    };

    net.of = (op) => net.calls.filter((c) => c.op === op);

    function disarm(call) {
        if (call.idle) {
            clearTimeout(call.idle);
            call.idle = null;
        }
    }

    // Node's socket idle timeout: 'timeout' on the request after idleMs with no activity.
    function arm(call) {
        disarm(call);
        if (call.endedAt !== null || !call.idleMs) return;
        call.idle = setTimeout(() => {
            call.idle = null;
            call.req.emit('timeout');
        }, call.idleMs);
    }

    function finish(call, outcome) {
        if (call.endedAt === null) {
            call.endedAt = Date.now();
            call.outcome = outcome;
        }
        disarm(call);
        call.timers.forEach((t) => clearTimeout(t));
        call.timers = [];
    }

    function good(call) {
        const reply = net.replies[call.op];
        if (!reply) return { data: null, errors: [{ message: `fake-https: no reply for ${call.op}` }] };
        return reply(call);
    }

    function startResponse(call, status, headers) {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers || {};
        res.complete = false;
        res.resume = () => res;
        call.res = res;
        call.status = status;
        call.cb(res);
        return res;
    }

    // A complete response: status, body, end, close (twice when `twice`).
    function answer(call, status, text, headers, twice) {
        finish(call, `HTTP ${status}`);
        const once = () => {
            const res = startResponse(call, status, headers);
            if (text) res.emit('data', Buffer.from(text));
            res.complete = true;
            res.emit('end');
            res.emit('close');
        };
        once();
        if (twice) once();
        call.req.emit('close');
    }

    function netError(call, message, code) {
        finish(call, code);
        const err = new Error(message);
        err.code = code;
        call.req.emit('error', err);
        call.req.emit('close');
    }

    const JSON_HEADERS = { 'content-type': 'application/json' };
    const HTML_HEADERS = { 'content-type': 'text/html' };

    function run(call, mode) {
        const { req } = call;
        if (req.destroyed || call.endedAt !== null) return;
        switch (mode) {
            case 'ok': return answer(call, 200, JSON.stringify(good(call)), JSON_HEADERS);
            case 'duplicate': return answer(call, 200, JSON.stringify(good(call)), JSON_HEADERS, true);
            case 'http500': return answer(call, 500, html('500 Internal Server Error'), HTML_HEADERS);
            // Gateway pages that echo a key or a token near the start (inside the 80-character snippet).
            case 'http502': return answer(call, 502, `<p>${KEY}</p>\n${html('502 Bad Gateway')}`, HTML_HEADERS);
            case 'http503': return answer(call, 503, `<p>${JWT}</p>\n${html('503 Service Temporarily Unavailable')}`, HTML_HEADERS);
            case 'http504': return answer(call, 504, html('504 Gateway Time-out'), HTML_HEADERS);
            case 'http429': return answer(call, 429, '{"detail":"Request was throttled. Expected available in 120 seconds."}',
                { 'content-type': 'application/json', 'retry-after': '120' });
            case 'http401': return answer(call, 401, JSON.stringify({
                errors: [{ message: 'Authentication failed.', extensions: { errorCode: 'KT-CT-1139', errorType: 'AUTHORIZATION' } }],
            }), JSON_HEADERS);
            case 'http403': return answer(call, 403, html('403 Forbidden'), HTML_HEADERS);
            case 'resetMidBody': {
                const res = startResponse(call, 200, JSON_HEADERS);
                res.emit('data', Buffer.from('{"data":{"devi'));
                finish(call, 'reset');
                res.emit('aborted');
                res.emit('close');
                req.emit('close');
                return undefined;
            }
            case 'econnreset': return netError(call, 'read ECONNRESET', 'ECONNRESET');
            case 'enotfound': return netError(call, `getaddrinfo ENOTFOUND ${call.host}`, 'ENOTFOUND');
            case 'etimedout': return netError(call, 'connect ETIMEDOUT 104.16.0.1:443', 'ETIMEDOUT');
            case 'hang': return undefined;
            case 'trickle': {
                const res = startResponse(call, 200, JSON_HEADERS);
                const drip = () => {
                    if (req.destroyed || call.endedAt !== null) return;
                    res.emit('data', Buffer.from(' '));
                    arm(call);
                    call.timers.push(setTimeout(drip, 10000));
                };
                drip();
                return undefined;
            }
            case 'empty': return answer(call, 200, '', JSON_HEADERS);
            case 'badjson': return answer(call, 200, '{"data": {"devices": [ <html>', JSON_HEADERS);
            case 'jsonNull': return answer(call, 200, 'null', JSON_HEADERS);
            case 'emptyObject': return answer(call, 200, '{}', JSON_HEADERS);
            case 'dataNull': return answer(call, 200, '{"data":null}', JSON_HEADERS);
            case 'errorsNoExt': return answer(call, 200, JSON.stringify({ data: null, errors: [{ message: 'Something went wrong.' }] }), JSON_HEADERS);
            case 'errorsLong': return answer(call, 200, JSON.stringify({
                data: null, errors: [{ message: LONG_MESSAGE, extensions: { errorCode: 'KT-CT-7899' } }],
            }), JSON_HEADERS);
            default: {
                // 'slow:<ms>': a good answer after <ms>.
                const slow = /^slow:(\d+)$/.exec(mode);
                if (slow) {
                    call.timers.push(setTimeout(() => run(call, 'ok'), Number(slow[1])));
                    return undefined;
                }
                throw new Error(`fake-https: unknown mode ${mode}`);
            }
        }
    }

    function dispatch(call) {
        if (call.req.destroyed || call.endedAt !== null) return;
        const gate = net.holds.find((g) => !g.call && g.op === call.op);
        if (gate) {
            gate.call = call;
            if (gate.mode) run(call, gate.mode);
            return;
        }
        const rule = net.rules.find((r) => r.op === call.op && r.used < r.times && (!r.when || r.when(call)));
        if (rule) {
            rule.used += 1;
            run(call, rule.mode);
            return;
        }
        run(call, 'ok');
    }

    function makeRequest(kind, host, options, cb) {
        const req = new EventEmitter();
        const call = {
            kind, host, options, cb, req, body: '', op: null,
            startedAt: Date.now(), endedAt: null, outcome: null, status: null, res: null,
            idle: null, idleMs: 0, timers: [],
        };
        req.destroyed = false;
        req.write = (chunk) => { call.body += String(chunk); return true; };
        req.setTimeout = (ms, fn) => {
            call.idleMs = ms;
            if (typeof fn === 'function') req.on('timeout', fn);
            arm(call);
            return req;
        };
        req.destroy = (err) => {
            if (req.destroyed) return req;
            req.destroyed = true;
            const answered = !!call.res;
            finish(call, 'destroyed');
            Promise.resolve().then(() => {
                if (call.res && !call.res.complete) {
                    call.res.emit('aborted');
                    call.res.emit('close');
                }
                if (err) {
                    req.emit('error', err);
                } else if (!answered) {
                    const hangUp = new Error('socket hang up');
                    hangUp.code = 'ECONNRESET';
                    req.emit('error', hangUp);
                }
                req.emit('close');
            });
            return req;
        };
        req.end = (chunk) => {
            if (chunk) req.write(chunk);
            call.startedAt = Date.now();
            call.op = opName(kind, call.body);
            net.calls.push(call);
            Promise.resolve().then(() => dispatch(call));
            return req;
        };
        return req;
    }

    return {
        __net: net,
        request: jest.fn((options, cb) => makeRequest('post', options && options.hostname, options, cb)),
        get: jest.fn((url, options, cb) => {
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
            const req = makeRequest('get', new URL(url).hostname, options, cb);
            req.end(); // https.get ends the request itself
            return req;
        }),
    };
}

module.exports = { createFakeHttps, MODES, FAILURE_MODES, KEY, JWT, EXPORT_MPAN, LONG_MESSAGE };

// __tests__/graphql-errors.test.js
'use strict';
const { onlyDeviceFieldErrors } = require('../lib/graphql-errors');

const data = { devices: [{ id: 'a' }, { id: 'b' }] };
const err = (path) => ({ message: 'x', path });

describe('onlyDeviceFieldErrors', () => {
    test('true when every error is on the named field of a device', () => {
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'status'])], data, 'status')).toBe(true);
        expect(onlyDeviceFieldErrors([err(['devices', 1, 'chargeCap', 'isChargingDurationCapped'])], data, 'chargeCap')).toBe(true);
    });
    test('false when any error is elsewhere', () => {
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'status']), err(['account'])], data, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'preferences', 'schedules'])], data, 'chargeCap')).toBe(false);
        expect(onlyDeviceFieldErrors([err(['devices'])], data, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors([{ message: 'no path' }], data, 'status')).toBe(false);
    });
    test('false when the error nulled the device itself or the device list', () => {
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'status'])], { devices: [null, { id: 'b' }] }, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'status'])], { devices: null }, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'status'])], null, 'status')).toBe(false);
    });
    test('accepts a list of fields: true when every error is on one of them', () => {
        const errs = [err(['devices', 0, 'chargeCap', 'isChargingDurationCapped']), err(['devices', 0, 'smartStatus'])];
        expect(onlyDeviceFieldErrors(errs, data, ['chargeCap', 'smartStatus'])).toBe(true);
        expect(onlyDeviceFieldErrors(errs, data, ['chargeCap'])).toBe(false);
        expect(onlyDeviceFieldErrors([err(['devices', 0, 'preferences'])], data, ['chargeCap', 'smartStatus'])).toBe(false);
    });
    test('false for no errors', () => {
        expect(onlyDeviceFieldErrors([], data, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors(undefined, data, 'status')).toBe(false);
    });
});

describe('onlyDeviceFieldErrors with several fields (1.6.2)', () => {
    test('true when every error is on one of the named fields', () => {
        const errors = [err(['devices', 0, 'preferences']), err(['devices', 0, 'chargeCap'])];
        expect(onlyDeviceFieldErrors(errors, data, ['preferences', 'chargeCap'])).toBe(true);
    });
    test('false when an error is on a field not named', () => {
        const errors = [err(['devices', 0, 'preferences']), err(['devices', 0, 'status'])];
        expect(onlyDeviceFieldErrors(errors, data, ['preferences', 'chargeCap'])).toBe(false);
    });
});

describe('graphqlError: short error text (1.6.2)', () => {
    const { graphqlError, MAX_ERROR_LENGTH } = require('../lib/graphql-errors');
    const kraken = (code, message) => ({ message, path: ['flexPlannedDispatches'], extensions: { errorCode: code } });

    test('code and message, no trailing full stop, no raw JSON', () => {
        const e = graphqlError([kraken('KT-CT-4340', 'Unable to fetch planned dispatches.')], 'Dispatches query failed');
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('KT-CT-4340: Unable to fetch planned dispatches');
        expect(e.code).toBe('KT-CT-4340');
        expect(e.detail).toBe('Unable to fetch planned dispatches');
    });
    test('an error with no code keeps the query name as context', () => {
        const e = graphqlError([{ message: 'boom', path: ['devices'] }], 'Devices query failed');
        expect(e.message).toBe('Devices query failed: boom');
        expect(e.code).toBeNull();
    });
    test('never longer than MAX_ERROR_LENGTH (under 255)', () => {
        expect(MAX_ERROR_LENGTH).toBeLessThan(255);
        const e = graphqlError([kraken('KT-CT-4340', 'x'.repeat(1000))], 'Dispatches query failed');
        expect(e.message.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
        expect(e.message.startsWith('KT-CT-4340: xxx')).toBe(true);
    });
    test('missing or empty errors still give a readable message', () => {
        expect(graphqlError(undefined, 'Devices query failed').message).toBe('Devices query failed: Unknown error');
        expect(graphqlError([{}], 'Devices query failed').message).toBe('Devices query failed: Unknown error');
    });
});

describe('graphqlError without a context (1.6.2)', () => {
    const { graphqlError } = require('../lib/graphql-errors');

    test('an error with no code gives the plain message', () => {
        const e = graphqlError([{ message: 'Account not found.', path: ['account'] }]);
        expect(e.message).toBe('Account not found');
        expect(e.code).toBeNull();
    });
    test('an error with a code still reads "CODE: message"', () => {
        const e = graphqlError([{ message: 'Unauthorized.', extensions: { errorCode: 'KT-CT-1111' } }]);
        expect(e.message).toBe('KT-CT-1111: Unauthorized');
    });
});

// Adversarial review A12: a GraphQL server can echo request variables (the API key) in an
// error message. No key or token may reach an *_error field, the status or the log.
describe('redact: API keys and tokens never pass through (1.6.2)', () => {
    const { redact, truncate, graphqlError } = require('../lib/graphql-errors');
    const KEY = 'sk_live_AbCdEf0123456789ZyXw';
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNzAwMDAwMDAwfQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU_-x';

    test('masks an Octopus API key', () => {
        const out = redact(`Variable '$input' got invalid value {'APIKey': '${KEY}'}`);
        expect(out).not.toContain(KEY);
        expect(out).not.toContain('AbCdEf0123456789');
        expect(out).toContain('sk_live_***');
    });
    test('masks a JWT (three base64url parts)', () => {
        const out = redact(`Token ${JWT} expired`);
        expect(out).not.toContain(JWT);
        expect(out).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
        expect(out).toBe('Token [token] expired');
    });
    test('masks every occurrence and literal secrets passed in', () => {
        const out = redact(`a ${KEY} b ${KEY} c my-own-secret-key`, ['my-own-secret-key']);
        expect(out).toBe('a sk_live_*** b sk_live_*** c ***');
    });
    test('masking twice gives the same text', () => {
        const once = redact(`key ${KEY} and ${JWT}`);
        expect(redact(once)).toBe(once);
        expect(once).toBe('key sk_live_*** and [token]');
    });
    test('ignores empty or short literal secrets', () => {
        expect(redact('abc def', ['', null, 'ab'])).toBe('abc def');
    });
    test('leaves ordinary error text alone', () => {
        const text = 'KT-CT-4340: Unable to fetch planned dispatches (api.backend.octopus.energy, v1.6.2)';
        expect(redact(text)).toBe(text);
        expect(redact('HTTP 503: <html>Service Unavailable</html>')).toBe('HTTP 503: <html>Service Unavailable</html>');
    });
    test('truncate cuts to the limit and does not mask', () => {
        const long = `${'x'.repeat(240)} ${KEY}`;
        const out = truncate(long);
        expect(out.length).toBeLessThanOrEqual(254);
        expect(out.endsWith('...')).toBe(true);
        expect(truncate(`bad key ${KEY}`)).toBe(`bad key ${KEY}`);
    });
    test('graphqlError keeps the message as Octopus sent it, key included, so a wrong key can be seen', () => {
        const e = graphqlError([{ message: `Variable '$input' got invalid value {'APIKey': '${KEY}'}` }], 'Auth');
        expect(e.message).toContain(KEY);
        expect(e.detail).toContain(KEY);
    });
});

// What is published to Home Assistant is masked; the Node-RED side is not.
describe('maskSecretsDeep: masks what is published to Home Assistant', () => {
    const { maskSecretsDeep } = require('../lib/graphql-errors');
    const KEY = 'sk_live_AbCdEf0123456789ZyXw';
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXZhbHVl';

    test('masks keys, tokens and the literal key in nested strings, and does not change the input', () => {
        const input = { intelligent_error: `bad ${KEY}`, list: [{ message: `t ${JWT}` }], n: 5, ok: null, own: 'x my-own-secret-key y' };
        const out = maskSecretsDeep(input, ['my-own-secret-key']);
        expect(out).toEqual({ intelligent_error: 'bad sk_live_***', list: [{ message: 't [token]' }], n: 5, ok: null, own: 'x *** y' });
        expect(input.intelligent_error).toBe(`bad ${KEY}`);
    });
    test('leaves numbers, booleans, null and ordinary text alone', () => {
        const state = { a: 1, b: true, c: null, d: 'KT-CT-4340: Unable to fetch planned dispatches', e: [1, 'x'] };
        expect(maskSecretsDeep(state)).toEqual(state);
    });
});

// Sweep 2026-10-08 #9: a network-level failure stops the rest of a tick.
describe('isNetworkError (1.6.2)', () => {
    const { isNetworkError, graphqlError } = require('../lib/graphql-errors');
    const withCode = (code) => Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });

    test('time-outs, dropped connections, socket errors and HTTP 5xx are network errors', () => {
        expect(isNetworkError(new Error('Octopus API request timed out after 30s'))).toBe(true);
        expect(isNetworkError(new Error('Octopus API connection closed before the response completed'))).toBe(true);
        expect(isNetworkError(new Error('Octopus API connection closed before a response arrived'))).toBe(true);
        expect(isNetworkError(new Error('HTTP 503: <html> Service Unavailable </html>'))).toBe(true);
        expect(isNetworkError(new Error('HTTP 502'))).toBe(true);
        ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']
            .forEach((code) => expect(isNetworkError(withCode(code))).toBe(true));
    });
    test('Kraken errors, rate limits, parse errors and plain errors are not', () => {
        expect(isNetworkError(graphqlError([{ message: 'Unable to fetch planned dispatches.', extensions: { errorCode: 'KT-CT-4340' } }]))).toBe(false);
        expect(isNetworkError(new Error('HTTP 429'))).toBe(false);
        expect(isNetworkError(new Error('HTTP 403: <html>Forbidden</html>'))).toBe(false);
        expect(isNetworkError(new Error('Failed to parse API response: Unexpected token'))).toBe(false);
        expect(isNetworkError(new Error('Response missing data'))).toBe(false);
        expect(isNetworkError(new Error('Poll superseded'))).toBe(false);
        expect(isNetworkError(null)).toBe(false);
        expect(isNetworkError(undefined)).toBe(false);
    });
});

// Review 5 R1: only a write that may have reached Octopus is "unconfirmed".
describe('isUnconfirmedWriteError (1.6.2)', () => {
    const { isUnconfirmedWriteError } = require('../lib/graphql-errors');
    const withCode = (code) => Object.assign(new Error(`getaddrinfo ${code} api.octopus.energy`), { code });

    test('a time-out, a connection closed after the request was sent, or HTTP 5xx is unconfirmed', () => {
        expect(isUnconfirmedWriteError(new Error('Octopus API request timed out after 30s'))).toBe(true);
        expect(isUnconfirmedWriteError(new Error('Octopus API connection closed before the response completed'))).toBe(true);
        expect(isUnconfirmedWriteError(new Error('Octopus API connection closed before a response arrived'))).toBe(true);
        expect(isUnconfirmedWriteError(new Error('HTTP 503'))).toBe(true);
        expect(isUnconfirmedWriteError(new Error('HTTP 502: <html> Bad gateway </html>'))).toBe(true);
        ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']
            .forEach((code) => expect(isUnconfirmedWriteError(withCode(code))).toBe(true));
    });

    test('DNS and connect errors, HTTP 4xx and unreadable replies are plain failures', () => {
        ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']
            .forEach((code) => expect(isUnconfirmedWriteError(withCode(code))).toBe(false));
        expect(isUnconfirmedWriteError(new Error('HTTP 403: <html>Forbidden</html>'))).toBe(false);
        expect(isUnconfirmedWriteError(new Error('HTTP 429'))).toBe(false);
        expect(isUnconfirmedWriteError(new Error('Failed to parse API response: Unexpected token <'))).toBe(false);
        expect(isUnconfirmedWriteError(new Error('Unexpected response shape: null'))).toBe(false);
        expect(isUnconfirmedWriteError(new Error('Octopus API response too large'))).toBe(false);
        expect(isUnconfirmedWriteError(null)).toBe(false);
    });
});

// Fuzz finding: /\.+$/ ran on the uncut Kraken message and is quadratic on a long run of dots
// followed by another character.
describe('graphqlError on a long run of dots (1.6.2)', () => {
    const { graphqlError } = require('../lib/graphql-errors');
    const { performance } = require('perf_hooks');

    test('50 kB of dots then a letter finishes under 200 ms with a short message', () => {
        const message = `${'.'.repeat(50 * 1024)}x`;
        graphqlError([{ message: 'warm up.' }]);
        const t0 = performance.now();
        const err = graphqlError([{ message, extensions: { errorCode: 'KT-CT-4340' } }]);
        expect(performance.now() - t0).toBeLessThan(200);
        expect(err.message.length).toBeLessThanOrEqual(254);
        expect(err.message.startsWith('KT-CT-4340: ...')).toBe(true);
    });

    test('trailing dots are still stripped', () => {
        expect(graphqlError([{ message: 'Unable to fetch planned dispatches...' }]).message).toBe('Unable to fetch planned dispatches');
        expect(graphqlError([{ message: '....' }]).message).toBe('Unknown error');
        expect(graphqlError([{ message: '  Done. ' }], 'ctx').message).toBe('ctx: Done');
    });
});

// Fuzz findings on redact (fuzz-redact.test.js on the 1.7 fuzz branch), ported for 1.6.2.
describe('redact edge cases (1.6.2)', () => {
    const { redact, truncate } = require('../lib/graphql-errors');
    const { performance } = require('perf_hooks');
    const MAX_REDACT_INPUT = 8192;
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNzAwMDAwMDAwfQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU_-x';

    // Ported from FINDING "redact is idempotent even for many tiny keys near the 8 kB cut".
    test('idempotent, and never past the cut, for many tiny keys near the 8 kB cut', () => {
        const text = 'sk_live_a '.repeat(1000); // 10,000 chars: masking each key makes it longer
        const once = redact(text);
        expect(redact(once)).toBe(once);
        expect(once.length).toBeLessThanOrEqual(MAX_REDACT_INPUT);
        expect(once).not.toMatch(/sk_live_[A-Za-z0-9_-]/);
    });

    // Ported from FINDING "redact/truncate never throw, even for a null-prototype object".
    test('never throws, even for a null-prototype object or a throwing toString', () => {
        const bare = Object.create(null);
        const hostile = { toString() { throw new Error('no'); } };
        expect(() => redact(bare)).not.toThrow();
        expect(() => truncate(bare)).not.toThrow();
        expect(() => redact(hostile)).not.toThrow();
        expect(redact(bare)).toBe('[object Object]');
        expect(typeof truncate(hostile)).toBe('string');
        expect(redact(Symbol('s'))).toBe('Symbol(s)');
    });

    // Ported from FINDING "a JWT after a long dotted word is masked completely".
    test('a JWT straight after a dotted word is masked completely, signature included', () => {
        const out = redact(`context.authorization_header.${JWT}`);
        for (const part of JWT.split('.')) expect(out).not.toContain(part);
        expect(out).toBe('context.[token]');
        expect(redact(`Bearer ${JWT}.`)).toBe('Bearer [token].');
    });

    test('dotted text with short parts is left alone', () => {
        expect(redact('api.backend.octopus.energy')).toBe('api.backend.octopus.energy');
        expect(redact('v1.6.2 node-red-contrib-octopus-intelligent')).toBe('v1.6.2 node-red-contrib-octopus-intelligent');
    });

    test.each([
        ['100 kB with no dot', 'a'.repeat(100 * 1024)],
        ['100 kB of 10-character parts and dots', 'aaaaaaaaaa.'.repeat(10 * 1024)],
        ['100 kB of 9-character parts and dots', 'aaaaaaaaa.'.repeat(10 * 1024)],
        ['100 kB of two long parts then a stop, repeated', 'aaaaaaaaaa.aaaaaaaaaa!'.repeat(4800)],
    ])('%s stays fast (under 200 ms)', (label, text) => {
        redact(text.slice(0, 64));
        const t0 = performance.now();
        const out = redact(text);
        expect(performance.now() - t0).toBeLessThan(200);
        expect(out.length).toBeLessThanOrEqual(MAX_REDACT_INPUT);
    });
});

// Second-eyes review D: shared by the charging poll and discovery.
test('statusNulledDevices lives in lib/graphql-errors.js and is the one the charging poll uses', () => {
    const { statusNulledDevices } = require('../lib/graphql-errors');
    expect(require('../lib/categories/intelligent').statusNulledDevices).toBe(statusNulledDevices);
    const err = { message: 'Device status could not be fetched.', path: ['devices', 0, 'status'], extensions: { errorCode: 'KT-CT-4360' } };
    expect(statusNulledDevices([err], { account: {}, devices: null })).toBe(true);
    expect(statusNulledDevices([err], { devices: [] })).toBe(false);
    expect(statusNulledDevices([null], { devices: null })).toBe(false);
});

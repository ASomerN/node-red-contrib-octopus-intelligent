'use strict';

// Error text stored in msg.payload.*_error and shown in HA must stay under 255 characters
// (the HA state length limit).
const MAX_ERROR_LENGTH = 254;

// Kraken can fail a single per-device field (e.g. KT-CT-4360) while returning everything else.
// True when every error sits under `devices[i].<field>` (field may be a list of fields) and the
// device list and those devices are still present: the failure stayed inside those fields and
// the rest is usable.
function onlyDeviceFieldErrors(errors, data, field) {
    if (!Array.isArray(errors) || errors.length === 0) return false;
    const devices = data && data.devices;
    if (!Array.isArray(devices)) return false;
    const fields = Array.isArray(field) ? field : [field];
    return errors.every((e) => Array.isArray(e.path)
        && e.path.length >= 3
        && e.path[0] === 'devices'
        && Number.isInteger(e.path[1])
        && devices[e.path[1]] != null
        && fields.includes(e.path[2]));
}

// True when the device list came back null because the device status failed: a GraphQL
// partial error whose path runs through `status` (or its alias `smartStatus`) on a device.
// `status` is non-null on the device and the list items are non-null too, so an error on it
// nulls `devices`, the nearest nullable field. Used by the charging poll and discovery, which
// then ask again without the status.
function statusNulledDevices(errors, data) {
    if (data && Array.isArray(data.devices)) return false;
    if (!Array.isArray(errors) || errors.length === 0) return false;
    const onDevice = (e) => !!e && Array.isArray(e.path) && e.path[0] === 'devices';
    const onStatus = (e) => onDevice(e) && (e.path.includes('status') || e.path.includes('smartStatus'));
    return errors.every(onDevice) && errors.some(onStatus);
}

function errorCode(e) {
    return (e && e.extensions && e.extensions.errorCode) || null;
}

// An Octopus API key, and anything shaped like a JWT (three base64url parts). A GraphQL
// server can echo request variables in an error message ("Variable '$input' got invalid
// value {'APIKey': 'sk_live_...'}"), so error text is masked before it is stored or logged.
// At least one key character, so text that is already masked ("sk_live_***") is left alone.
const API_KEY_PATTERN = /sk_live_[A-Za-z0-9_-]+/g;
// Matches only start at the beginning of a run of token characters, so a long run with no
// dots is scanned once, not from every position (which was quadratic). A run can start just
// after a dot, and it takes every further dotted part: a JWT straight after a dotted word
// ("x.authorization_header.<jwt>") is masked whole, signature included, not cut after its
// second part.
const JWT_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2,}/g;
// Text past this is cut before masking: every caller keeps far less than this.
const MAX_REDACT_INPUT = 8192;
const MIN_SECRET_LENGTH = 8;

// Any value as text. String() throws for an object with no prototype or a throwing toString.
function toText(value) {
    try {
        return String(value);
    } catch (e) {
        try {
            return Object.prototype.toString.call(value);
        } catch (e2) {
            return '[unprintable]';
        }
    }
}

function mask(s, secrets) {
    // Patterns first, so a masked key still reads sk_live_*** and shows what was hidden.
    let out = s.replace(API_KEY_PATTERN, 'sk_live_***').replace(JWT_PATTERN, '[token]');
    for (const secret of secrets || []) {
        if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('***');
    }
    return out;
}

// Mask API keys and tokens in `text`. `secrets` are literal values to mask as well (the
// node's own API key); empty or very short ones are ignored. Never throws, never longer than
// MAX_REDACT_INPUT, and redact(redact(x)) === redact(x).
function redact(text, secrets = []) {
    let s = toText(text);
    // Cut first so the work is bounded, mask, then cut again: masking "sk_live_a" makes it
    // longer, so many tiny keys near the cut could push the text past it. The second cut can
    // leave a partial mask but never a partial secret; mask once more to be sure.
    if (s.length > MAX_REDACT_INPUT) s = s.slice(0, MAX_REDACT_INPUT);
    s = mask(s, secrets);
    if (s.length > MAX_REDACT_INPUT) s = mask(s.slice(0, MAX_REDACT_INPUT), secrets);
    return s;
}

// Cut to `max` characters. Not masked: the Node-RED log, status and msg show the real text,
// including a wrong key echoed by Octopus. What is published to Home Assistant goes through
// maskSecretsDeep first.
function truncate(text, max = MAX_ERROR_LENGTH) {
    const s = toText(text);
    return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

// A copy of `value` with API keys and tokens masked in every string (objects and arrays are
// walked). Applied to what is published over MQTT, where HA stores it in its history.
function maskSecretsDeep(value, secrets = [], depth = 0) {
    if (typeof value === 'string') return redact(value, secrets);
    if (value === null || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map((v) => maskSecretsDeep(v, secrets, depth + 1));
    const out = {};
    for (const k of Object.keys(value)) out[k] = maskSecretsDeep(value[k], secrets, depth + 1);
    return out;
}

// "Unable to fetch planned dispatches." -> "... dispatches". A loop from the end, not /\.+$/:
// that regex retries from every dot of a run, so a long run of dots followed by any other
// character is quadratic.
function stripTrailingDots(s) {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 46) end--;
    return s.slice(0, end);
}

// A short, readable Error from a Kraken GraphQL errors array: "KT-CT-4340: Unable to fetch
// planned dispatches". Without a Kraken code the message is prefixed with `context` instead,
// or is the plain message when no context is given.
// The Error carries .code (or null) and .detail (the message without the code).
function graphqlError(errors, context) {
    const first = (Array.isArray(errors) && errors[0]) || {};
    const code = errorCode(first);
    // The message comes from the response body and can be long: every step here is linear.
    const detail = stripTrailingDots(toText(first.message || '').trim()) || 'Unknown error';
    const prefix = code || context;
    const err = new Error(truncate(prefix ? `${prefix}: ${detail}` : detail));
    err.code = code;
    err.detail = detail;
    return err;
}

// Socket-level error codes from Node (err.code) that mean the server could not be reached.
const NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED'];

// True when a request failed because Octopus could not be reached or did not answer: a
// time-out, a dropped connection, a socket error or an HTTP 5xx (lib/graphql.js messages).
// A Kraken GraphQL error, an HTTP 4xx (429 included) or a parse error is not one.
function isNetworkError(err) {
    if (!err) return false;
    if (NETWORK_ERROR_CODES.includes(err.code)) return true;
    const msg = toText(err.message || '');
    return /^HTTP 5\d\d\b/.test(msg)
        || /request timed out/i.test(msg)
        || /connection closed before/i.test(msg);
}

// Socket errors raised before the request could reach Octopus: the name did not resolve or
// the connection was never made. A write that fails like this was not applied.
const NOT_SENT_ERROR_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN'];
// Socket errors on a connection that was made: the request may have reached Octopus.
const MAYBE_SENT_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'];

// True when a write (mutation) failed in a way that leaves it unknown whether Octopus applied
// it: a time-out, a connection closed after the request was sent, or an HTTP 5xx. A DNS or
// connect error, an HTTP 4xx and a reply that could not be read are plain failures.
function isUnconfirmedWriteError(err) {
    if (!err) return false;
    if (NOT_SENT_ERROR_CODES.includes(err.code)) return false;
    if (MAYBE_SENT_ERROR_CODES.includes(err.code)) return true;
    const msg = toText(err.message || '');
    return /^HTTP 5\d\d\b/.test(msg)
        || /request timed out/i.test(msg)
        || /connection closed before/i.test(msg);
}

module.exports = {
    onlyDeviceFieldErrors, statusNulledDevices, graphqlError, errorCode, truncate, redact, maskSecretsDeep, isNetworkError, isUnconfirmedWriteError,
    MAX_ERROR_LENGTH,
};

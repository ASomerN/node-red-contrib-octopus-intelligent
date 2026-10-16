'use strict';
const {
    BOOST_MUTATION, buildBoostRequest, parseBoostResponse, formatKrakenErrors,
    isBoosting, slotActiveAt, chargingNowFor, reconcileChargingNow,
} = require('../lib/boost');

// Shapes mirror the live schema (introspection 6 Oct 2026):
// updateBoostCharge(input: {deviceId: String!, action: UpdateBoostChargeAction!}) -> SmartFlexDeviceInterface
const deviceResult = (currentState) => ({
    data: { data: { updateBoostCharge: { id: '00000000-0000-0000-0000-000000000001', status: { currentState } } } },
});

describe('buildBoostRequest', () => {
    test('true sends action BOOST with the device id', () => {
        expect(buildBoostRequest('dev-1', true)).toEqual({
            query: BOOST_MUTATION,
            variables: { deviceId: 'dev-1', action: 'BOOST' },
        });
    });

    test('false sends action CANCEL', () => {
        expect(buildBoostRequest('dev-1', false).variables.action).toBe('CANCEL');
    });

    test('mutation uses only the live-verified type names', () => {
        expect(BOOST_MUTATION).toMatch(/\$deviceId:\s*String!/);
        expect(BOOST_MUTATION).toMatch(/\$action:\s*UpdateBoostChargeAction!/);
        expect(BOOST_MUTATION).toMatch(/updateBoostCharge\(input:\s*\{\s*deviceId:\s*\$deviceId,\s*action:\s*\$action\s*\}\)/);
    });

    // Review A2: status is non-null and KT-CT-4360 has been seen on it. An error there would
    // null the answer and make a boost that went through look refused, so only id is read.
    test('mutation reads back only the device id, not status', () => {
        expect(BOOST_MUTATION).not.toMatch(/status/);
        expect(BOOST_MUTATION).toMatch(/\)\s*\{\s*id\s*\}\s*\}$/);
    });
});

describe('isBoosting', () => {
    test.each([
        ['BOOSTING', true],
        ['SMART_CONTROL_CAPABLE', false],
        ['SMART_CONTROL_IN_PROGRESS', false],
        ['SMART_CONTROL_NOT_AVAILABLE', false],
        ['LOST_CONNECTION', false],
        [null, null],
        [undefined, null],
    ])('%p -> %p', (state, expected) => {
        expect(isBoosting(state)).toBe(expected);
    });
});

// The refusal error code has not been seen live, so nothing depends on a particular code:
// any code is passed through in the short "CODE: message" form used for intelligent_error.
describe('formatKrakenErrors', () => {
    test('uses the short "KT-CT-xxxx: message" form, without the trailing full stop', () => {
        const errors = [{ message: 'Boost charge not possible.', extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4399' } }];
        expect(formatKrakenErrors(errors)).toBe('KT-CT-4399: Boost charge not possible');
    });

    test('falls back to the message when there is no code', () => {
        expect(formatKrakenErrors([{ message: 'Something failed' }])).toBe('Something failed');
    });

    test('stays under 255 characters', () => {
        const long = formatKrakenErrors([{ message: 'x'.repeat(1000), extensions: { errorCode: 'KT-CT-9999' } }]);
        expect(long.length).toBeLessThan(255);
        expect(long.startsWith('KT-CT-9999: ')).toBe(true);
    });

    test('joins several errors', () => {
        expect(formatKrakenErrors([
            { message: 'A', extensions: { errorCode: 'KT-CT-1' } },
            { message: 'B' },
        ])).toBe('KT-CT-1: A; B');
    });

    test('never returns an empty string', () => {
        expect(formatKrakenErrors([])).toBe('Unknown error');
        expect(formatKrakenErrors(undefined)).toBe('Unknown error');
    });
});

describe('parseBoostResponse', () => {
    test('BOOSTING read back -> ok, boosting true', () => {
        expect(parseBoostResponse(deviceResult('BOOSTING'))).toEqual({ ok: true, unclear: false, currentState: 'BOOSTING', boosting: true, error: null });
    });

    test('cancel read back -> ok, boosting false', () => {
        expect(parseBoostResponse(deviceResult('SMART_CONTROL_CAPABLE'))).toEqual({ ok: true, unclear: false, currentState: 'SMART_CONTROL_CAPABLE', boosting: false, error: null });
    });

    test.each([
        ['KT-CT-1234', 'Unable to boost charge.', 'KT-CT-1234: Unable to boost charge'],
        ['KT-CT-4399', 'Vehicle is not plugged in.', 'KT-CT-4399: Vehicle is not plugged in'],
        [undefined, 'Something went wrong.', 'Something went wrong'],
    ])('an error on the mutation itself is a clean refusal, whatever the code (%p): not ok, short error, boosting unknown', (code, message, expected) => {
        const err = { message, path: ['updateBoostCharge'], extensions: code ? { errorType: 'APPLICATION', errorCode: code } : {} };
        const res = { data: { data: { updateBoostCharge: null }, errors: [err] } };
        expect(parseBoostResponse(res)).toEqual({ ok: false, unclear: false, currentState: null, boosting: null, error: expected });
    });

    test('an error with a device still read back is unclear: the read-back state is not used', () => {
        const res = { data: {
            data: { updateBoostCharge: { id: 'x', status: { currentState: 'BOOSTING' } } },
            errors: [{ message: 'Boost not applied.', path: ['updateBoostCharge'], extensions: { errorCode: 'KT-CT-7777' } }],
        } };
        expect(parseBoostResponse(res)).toEqual({ ok: false, unclear: true, currentState: null, boosting: null, error: 'KT-CT-7777: Boost not applied' });
    });

    test('an error with no path and no device is a clean refusal', () => {
        const res = { data: { errors: [{ message: 'Unable to boost charge.', extensions: { errorCode: 'KT-CT-1234' } }] } };
        expect(parseBoostResponse(res)).toEqual({ ok: false, unclear: false, currentState: null, boosting: null, error: 'KT-CT-1234: Unable to boost charge' });
    });

    // Review A2: a KT-CT-4360 on the read-back nulls the answer even when the boost went through.
    test('an error deeper in the answer (on the read-back) is unclear, not a refusal', () => {
        const res = { data: {
            data: { updateBoostCharge: null },
            errors: [{ message: 'Unable to get device status.', path: ['updateBoostCharge', 'status', 'currentState'], extensions: { errorCode: 'KT-CT-4360' } }],
        } };
        expect(parseBoostResponse(res)).toEqual({ ok: false, unclear: true, currentState: null, boosting: null, error: 'KT-CT-4360: Unable to get device status' });
    });

    test('a mix of a mutation error and a deeper error is unclear', () => {
        const res = { data: {
            data: { updateBoostCharge: null },
            errors: [
                { message: 'Boost not applied.', path: ['updateBoostCharge'], extensions: { errorCode: 'KT-CT-7777' } },
                { message: 'Unable to get device status.', path: ['updateBoostCharge', 'status'], extensions: { errorCode: 'KT-CT-4360' } },
            ],
        } };
        expect(parseBoostResponse(res).unclear).toBe(true);
    });

    test('an empty errors list is not a refusal', () => {
        const res = { data: { data: { updateBoostCharge: { id: 'x', status: { currentState: 'BOOSTING' } } }, errors: [] } };
        expect(parseBoostResponse(res)).toEqual({ ok: true, unclear: false, currentState: 'BOOSTING', boosting: true, error: null });
    });

    test('missing device and no error in the result -> not ok and unclear (no read-back)', () => {
        const r = parseBoostResponse({ data: { data: { updateBoostCharge: null } } });
        expect(r.ok).toBe(false);
        expect(r.unclear).toBe(true);
        expect(r.error).toMatch(/no device/i);
    });

    test('device without status -> ok, boosting unknown', () => {
        const r = parseBoostResponse({ data: { data: { updateBoostCharge: { id: 'x', status: null } } } });
        expect(r).toEqual({ ok: true, unclear: false, currentState: null, boosting: null, error: null });
    });

    test('device id only (what the mutation now selects) -> ok, boosting unknown', () => {
        const r = parseBoostResponse({ data: { data: { updateBoostCharge: { id: 'x' } } } });
        expect(r).toEqual({ ok: true, unclear: false, currentState: null, boosting: null, error: null });
    });
});

describe('charging_now with a boost', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const pastSlot = { start: '2026-10-07T01:00:00Z', end: '2026-10-07T02:00:00Z' };
    const activeSlot = { start: '2026-10-07T11:30:00Z', end: '2026-10-07T12:30:00Z' };
    const futureSlot = { start: '2026-10-07T23:30:00Z', end: '2026-10-08T01:00:00Z' };

    test('slotActiveAt finds a slot covering now', () => {
        expect(slotActiveAt([pastSlot, activeSlot], now)).toBe(true);
        expect(slotActiveAt([pastSlot, futureSlot], now)).toBe(false);
        expect(slotActiveAt([], now)).toBe(false);
        expect(slotActiveAt(null, now)).toBe(false);
    });

    test.each([
        [[activeSlot], false, true],
        [[activeSlot], true, true],
        [[futureSlot], true, true],
        [[], true, true],
        [[futureSlot], false, false],
        [[futureSlot], null, false],
        [[], false, false],
    ])('slots %j, boosting %p -> charging_now %p', (slots, boosting, expected) => {
        expect(chargingNowFor(slots, boosting, now)).toBe(expected);
    });
});

describe('reconcileChargingNow (10 s reconciliation)', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const activeSlot = { start: '2026-10-07T11:30:00Z', end: '2026-10-07T12:30:00Z' };
    const futureSlot = { start: '2026-10-07T23:30:00Z', end: '2026-10-08T01:00:00Z' };

    test('does not correct a boost back to false (no slot active)', () => {
        expect(reconcileChargingNow({ slots: [futureSlot], boosting: true, chargingNow: true, now })).toBeNull();
    });

    test('does not correct a boost back to false (no slots at all)', () => {
        expect(reconcileChargingNow({ slots: [], boosting: true, chargingNow: true, now })).toBeNull();
    });

    test('turns charging_now on when a boost is known but charging_now is off', () => {
        expect(reconcileChargingNow({ slots: [], boosting: true, chargingNow: false, now })).toBe(true);
    });

    test('still corrects to false once the boost has ended and no slot is active', () => {
        expect(reconcileChargingNow({ slots: [futureSlot], boosting: false, chargingNow: true, now })).toBe(false);
    });

    test('still corrects to true when a slot is active', () => {
        expect(reconcileChargingNow({ slots: [activeSlot], boosting: false, chargingNow: false, now })).toBe(true);
    });

    test('no slots and no boost: leaves charging_now alone, as before', () => {
        expect(reconcileChargingNow({ slots: [], boosting: false, chargingNow: true, now })).toBeNull();
        expect(reconcileChargingNow({ slots: null, boosting: null, chargingNow: false, now })).toBeNull();
    });

    test('in sync: no change', () => {
        expect(reconcileChargingNow({ slots: [activeSlot], boosting: true, chargingNow: true, now })).toBeNull();
    });
});

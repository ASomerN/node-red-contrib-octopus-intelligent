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
    test('false for no errors', () => {
        expect(onlyDeviceFieldErrors([], data, 'status')).toBe(false);
        expect(onlyDeviceFieldErrors(undefined, data, 'status')).toBe(false);
    });
});

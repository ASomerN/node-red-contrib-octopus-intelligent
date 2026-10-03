'use strict';
const { TIME_OPTIONS, validateTime, validateLimit } = require('../lib/preferences');

describe('TIME_OPTIONS', () => {
    test('has 48 half-hour slots from 00:00 to 23:30', () => {
        expect(TIME_OPTIONS).toHaveLength(48);
        expect(TIME_OPTIONS[0]).toBe('00:00');
        expect(TIME_OPTIONS[1]).toBe('00:30');
        expect(TIME_OPTIONS[47]).toBe('23:30');
        expect(TIME_OPTIONS).toContain('11:30'); // issue #3
        expect(TIME_OPTIONS).toContain('19:30');
    });
});

describe('validateTime', () => {
    test.each(['00:00', '04:00', '11:30', '19:30', '23:30'])('accepts %s', (t) => {
        expect(validateTime(t)).toEqual({ ok: true, time: t });
    });

    test.each([
        ['07:15'], ['24:00'], ['7:30'], ['07:30:00'], [''], [null], [undefined], [730], ['abc'],
    ])('rejects %p', (t) => {
        const r = validateTime(t);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Invalid ready-by time/);
        expect(r.error).toMatch(/00:00–23:30/);
    });
});

describe('validateLimit', () => {
    test('accepts and keeps a valid multiple of 5', () => {
        expect(validateLimit(85)).toEqual({ ok: true, limit: 85 });
    });
    test('accepts numeric strings', () => {
        expect(validateLimit('90')).toEqual({ ok: true, limit: 90 });
    });
    test('accepts values below 50 down to 5, as the Octopus app does (#3)', () => {
        expect(validateLimit(30)).toEqual({ ok: true, limit: 30 });
        expect(validateLimit(5)).toEqual({ ok: true, limit: 5 });
    });
    test('rounds low values to the nearest 5', () => {
        expect(validateLimit(32)).toEqual({ ok: true, limit: 30 });
        expect(validateLimit(8)).toEqual({ ok: true, limit: 10 });
    });
    test('clamps below 5 up to 5', () => {
        expect(validateLimit(3)).toEqual({ ok: true, limit: 5 });
        expect(validateLimit(1)).toEqual({ ok: true, limit: 5 });
    });
    test('clamps above 100 down to 100', () => {
        expect(validateLimit(120)).toEqual({ ok: true, limit: 100 });
    });
    test('rounds to nearest 5', () => {
        expect(validateLimit(83)).toEqual({ ok: true, limit: 85 });
    });
    test.each([['8O'], ['85%'], ['90abc'], [true], [[90]], ['0x5A'], ['1e2'], [Infinity]])('rejects non-decimal input %p', (l) => {
        const r = validateLimit(l);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Invalid charge limit/);
    });
    test('accepts decimal strings from the HA number entity', () => {
        expect(validateLimit('85.0')).toEqual({ ok: true, limit: 85 });
        expect(validateLimit(' 90 ')).toEqual({ ok: true, limit: 90 });
    });
    test.each([[0], ['abc'], [''], [null], [undefined], [NaN]])('rejects %p', (l) => {
        const r = validateLimit(l);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Invalid charge limit/);
        expect(r.error).toMatch(/between 5 and 100/);
    });
});

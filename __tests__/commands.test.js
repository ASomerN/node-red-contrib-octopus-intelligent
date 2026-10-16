'use strict';
const { planCommands } = require('../lib/commands');

const current = { confirmedLimit: 80, confirmedTime: '07:30' };

describe('planCommands', () => {
    test('issue #3 payload is accepted', () => {
        const r = planCommands({ set_limit: 85, set_time: '11:30' }, current);
        expect(r.errors).toEqual([]);
        expect(r.actions).toEqual([{ type: 'preferences', limit: 85, time: '11:30' }]);
    });

    test('limit only keeps confirmed time, even when off-step', () => {
        const r = planCommands({ set_limit: 90 }, { confirmedLimit: 80, confirmedTime: '07:15' });
        expect(r.errors).toEqual([]);
        expect(r.actions).toEqual([{ type: 'preferences', limit: 90, time: '07:15' }]);
    });

    test('time only keeps confirmed limit', () => {
        const r = planCommands({ set_time: '19:30' }, current);
        expect(r.actions).toEqual([{ type: 'preferences', limit: 80, time: '19:30' }]);
    });

    test('null command key is ignored alongside a real command', () => {
        const r = planCommands({ set_limit: 85, set_time: null }, current);
        expect(r.errors).toEqual([]);
        expect(r.actions).toEqual([{ type: 'preferences', limit: 85, time: '07:30' }]);
    });

    test('null-only payload is not a command', () => {
        const r = planCommands({ set_time: null }, current);
        expect(r.hasCommand).toBe(false);
        expect(r.actions).toEqual([]);
        expect(r.errors).toEqual([]);
    });

    test('empty-string time is still rejected', () => {
        const r = planCommands({ set_time: '' }, current);
        expect(r.errors).toHaveLength(1);
    });

    test('invalid time rejects the whole preferences change', () => {
        const r = planCommands({ set_limit: 85, set_time: '07:15' }, current);
        expect(r.actions).toEqual([]);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/Invalid ready-by time '07:15'/);
    });

    test('set_limit: 0 is rejected, not ignored', () => {
        const r = planCommands({ set_limit: 0 }, current);
        expect(r.hasCommand).toBe(true);
        expect(r.actions).toEqual([]);
        expect(r.errors[0]).toMatch(/Invalid charge limit/);
    });

    test('non-numeric limit is rejected', () => {
        const r = planCommands({ set_limit: 'abc' }, current);
        expect(r.actions).toEqual([]);
        expect(r.errors[0]).toMatch(/Invalid charge limit/);
    });

    test('all valid commands in one msg run', () => {
        const r = planCommands({
            set_limit: 90, set_time: '06:00', set_timezone: ' Europe/London ',
            set_smart_charging: true, set_charge_cap: false,
        }, current);
        expect(r.errors).toEqual([]);
        expect(r.actions).toEqual([
            { type: 'preferences', limit: 90, time: '06:00' },
            { type: 'timezone', timezone: 'Europe/London' },
            { type: 'smart_charging', enabled: true },
            { type: 'charge_cap', enabled: false },
        ]);
    });

    test('invalid time does not block a valid charge cap change', () => {
        const r = planCommands({ set_time: '11:15', set_charge_cap: true }, current);
        expect(r.actions).toEqual([{ type: 'charge_cap', enabled: true }]);
        expect(r.errors).toHaveLength(1);
    });

    test('non-boolean switches are ignored silently', () => {
        const r = planCommands({ set_charge_cap: 'true', set_smart_charging: 1 }, current);
        expect(r.hasCommand).toBe(true);
        expect(r.actions).toEqual([]);
        expect(r.errors).toEqual([]);
    });

    test('set_boost true plans a BOOST, false plans a CANCEL', () => {
        expect(planCommands({ set_boost: true }, current).actions).toEqual([{ type: 'boost', enabled: true }]);
        expect(planCommands({ set_boost: false }, current).actions).toEqual([{ type: 'boost', enabled: false }]);
    });

    test.each(['true', 1, 0, 'BOOST', 'ON', {}, []])('non-boolean set_boost %p is an error, not a boost', (v) => {
        const r = planCommands({ set_boost: v }, current);
        expect(r.hasCommand).toBe(true);
        expect(r.actions).toEqual([]);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^Invalid set_boost '.*' — must be true or false$/);
    });

    test('the set_boost error shows the value, cut short when long', () => {
        expect(planCommands({ set_boost: 'true' }, current).errors[0]).toBe("Invalid set_boost 'true' — must be true or false");
        expect(planCommands({ set_boost: 1 }, current).errors[0]).toBe("Invalid set_boost '1' — must be true or false");
        const long = planCommands({ set_boost: 'x'.repeat(500) }, current).errors[0];
        expect(long.length).toBeLessThan(100);
    });

    test('a bad set_boost does not block the other commands in the message', () => {
        const r = planCommands({ set_charge_cap: true, set_boost: 'yes' }, current);
        expect(r.actions).toEqual([{ type: 'charge_cap', enabled: true }]);
        expect(r.errors).toHaveLength(1);
    });

    test('set_boost: null is not a command', () => {
        expect(planCommands({ set_boost: null }, current).hasCommand).toBe(false);
    });

    test('set_boost runs alongside other commands in one msg', () => {
        const r = planCommands({ set_limit: 90, set_smart_charging: true, set_charge_cap: true, set_boost: true }, current);
        expect(r.errors).toEqual([]);
        expect(r.actions).toEqual([
            { type: 'preferences', limit: 90, time: '07:30' },
            { type: 'smart_charging', enabled: true },
            { type: 'charge_cap', enabled: true },
            { type: 'boost', enabled: true },
        ]);
    });

    test('invalid time does not block a valid boost', () => {
        const r = planCommands({ set_time: '11:15', set_boost: false }, current);
        expect(r.actions).toEqual([{ type: 'boost', enabled: false }]);
        expect(r.errors).toHaveLength(1);
    });

    test('empty timezone is ignored silently', () => {
        const r = planCommands({ set_timezone: '   ' }, current);
        expect(r.hasCommand).toBe(true);
        expect(r.actions).toEqual([]);
    });

    test('no command keys means hasCommand false (manual refresh)', () => {
        const r = planCommands({ foo: 1 }, current);
        expect(r).toEqual({ actions: [], errors: [], hasCommand: false });
    });
});

// Fuzz finding: set_timezone was only trimmed, so any text was stored and published.
describe('planCommands set_timezone validation (1.6.2)', () => {
    // Ported from the fuzz FINDING "planCommands rejects a timezone Intl does not know, or one too long for HA".
    test('rejects a timezone Intl does not know, or one too long for HA', () => {
        for (const tz of ['Not/AZone', 'Europe/Londn', `Europe/${'X'.repeat(300)}`]) {
            const plan = planCommands({ set_timezone: tz }, current);
            expect(plan.actions.find((a) => a.type === 'timezone')).toBeUndefined();
            expect(plan.errors.length).toBeGreaterThan(0);
            expect(plan.errors[0]).toMatch(/^Invalid timezone '/);
            expect(plan.errors[0].length).toBeLessThan(120);
        }
        expect(planCommands({ set_timezone: ' Europe/London ' }, {}).actions).toEqual([{ type: 'timezone', timezone: 'Europe/London' }]);
    });

    test('a non-text value is an error, not ignored silently', () => {
        const plan = planCommands({ set_timezone: 5 }, current);
        expect(plan.actions).toEqual([]);
        expect(plan.errors).toEqual(["Invalid timezone '5' — must be an IANA name such as Europe/London"]);
    });

    test('a 64-character limit', () => {
        const { validateTimezone, MAX_TIMEZONE_LENGTH } = require('../lib/timezone');
        expect(MAX_TIMEZONE_LENGTH).toBe(64);
        expect(validateTimezone(`${' '.repeat(100)}UTC`)).toEqual({ ok: true, timezone: 'UTC' });
        expect(validateTimezone('A'.repeat(65)).ok).toBe(false);
    });
});

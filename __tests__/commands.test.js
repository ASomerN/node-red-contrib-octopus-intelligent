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

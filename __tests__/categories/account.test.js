// __tests__/categories/account.test.js
'use strict';
const account = require('../../lib/categories/account');

describe('account category', () => {
    test('buildQuery includes balance', () => {
        const { query } = account.buildQuery('A-TEST-1234');
        expect(query).toContain('balance');
        expect(query).toContain('$account');
    });

    test('parseResponse extracts balance in pence and pounds', () => {
        const result = account.parseResponse({ account: { balance: 10900 } });
        expect(result.account_balance_pence).toBe(10900);
        expect(result.account_balance_pounds).toBe(109.00);
        expect(result.account_error).toBeNull();
    });

    test('parseResponse handles negative balance (in debt)', () => {
        const result = account.parseResponse({ account: { balance: -500 } });
        expect(result.account_balance_pence).toBe(-500);
        expect(result.account_balance_pounds).toBe(-5.00);
    });

    test('parseResponse handles zero balance', () => {
        const result = account.parseResponse({ account: { balance: 0 } });
        expect(result.account_balance_pence).toBe(0);
        expect(result.account_balance_pounds).toBe(0);
    });

    test('parseResponse handles missing account', () => {
        const result = account.parseResponse({});
        expect(result.account_balance_pence).toBeNull();
        expect(result.account_balance_pounds).toBeNull();
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(account.parseResponse({}));
        const populatedKeys = Object.keys(account.parseResponse({ account: { balance: 100 } }));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(account.defaultData).toHaveProperty(key);
        }
    });
});

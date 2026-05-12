// __tests__/categories/octoplus.test.js
'use strict';
const octoplus = require('../../lib/categories/octoplus');

describe('octoplus category', () => {
    test('buildQuery includes octoplusAccountInfo', () => {
        const { query } = octoplus.buildQuery('A-TEST-1234');
        expect(query).toContain('octoplusAccountInfo');
        expect(query).toContain('$account');
    });

    test('parseResponse extracts enrollment status and loyalty flag', () => {
        const result = octoplus.parseResponse({
            octoplusAccountInfo: {
                isOctoplusEnrolled: true,
                enrollmentStatus: 'ENROLLED',
                isLoyaltyPointsUser: true
            }
        });
        expect(result.octoplus_enrolled).toBe(true);
        expect(result.octoplus_enrollment_status).toBe('ENROLLED');
        expect(result.octoplus_loyalty_points_user).toBe(true);
        expect(result.octoplus_error).toBeNull();
    });

    test('parseResponse handles non-enrolled account', () => {
        const result = octoplus.parseResponse({
            octoplusAccountInfo: {
                isOctoplusEnrolled: false,
                enrollmentStatus: 'NOT_ENROLLED',
                isLoyaltyPointsUser: false
            }
        });
        expect(result.octoplus_enrolled).toBe(false);
        expect(result.octoplus_enrollment_status).toBe('NOT_ENROLLED');
    });

    test('parseResponse handles missing info gracefully', () => {
        const result = octoplus.parseResponse({});
        expect(result.octoplus_enrolled).toBeNull();
        expect(result.octoplus_enrollment_status).toBeNull();
        expect(result.octoplus_loyalty_points_user).toBeNull();
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(octoplus.parseResponse({}));
        const populatedKeys = Object.keys(octoplus.parseResponse({
            octoplusAccountInfo: { isOctoplusEnrolled: true, enrollmentStatus: 'ENROLLED', isLoyaltyPointsUser: true }
        }));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(octoplus.defaultData).toHaveProperty(key);
        }
    });
});

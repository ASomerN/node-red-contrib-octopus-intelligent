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

// isOctoplusEnrolled is deprecated by Kraken (removal "on or after 1 Aug 2025"). If the field
// goes, selecting it fails the whole query, so octoplus_enrolled comes from enrollmentStatus.
describe('octoplus_enrolled from enrollmentStatus (1.6.2)', () => {
    const { buildQuery, parseResponse } = require('../../lib/categories/octoplus');

    test('the query no longer selects the deprecated isOctoplusEnrolled', () => {
        expect(buildQuery('A-XXXXXXXX').query).not.toMatch(/isOctoplusEnrolled/);
        expect(buildQuery('A-XXXXXXXX').query).toMatch(/enrollmentStatus/);
    });

    test.each([
        ['ENROLLED', true],
        ['UNENROLLED_NEVER_ENROLLED', false],
        ['UNENROLLED_PREVIOUSLY_ENROLLED', false],
    ])('%s gives octoplus_enrolled %s', (status, enrolled) => {
        const r = parseResponse({ octoplusAccountInfo: { enrollmentStatus: status, isLoyaltyPointsUser: true } });
        expect(r.octoplus_enrolled).toBe(enrolled);
        expect(r.octoplus_enrollment_status).toBe(status);
    });

    test('a missing status gives null, not false', () => {
        expect(parseResponse({ octoplusAccountInfo: {} }).octoplus_enrolled).toBeNull();
        expect(parseResponse({}).octoplus_enrolled).toBeNull();
    });
});

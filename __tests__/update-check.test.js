'use strict';
const { checkUpdate, compareSemver } = require('../lib/update-check');

describe('compareSemver', () => {
    it('returns 0 for equal versions', () => {
        expect(compareSemver('1.4.0', '1.4.0')).toBe(0);
    });
    it('returns positive when a > b (patch)', () => {
        expect(compareSemver('1.4.1', '1.4.0')).toBeGreaterThan(0);
    });
    it('returns negative when a < b (patch)', () => {
        expect(compareSemver('1.4.0', '1.4.1')).toBeLessThan(0);
    });
    it('handles minor bumps', () => {
        expect(compareSemver('1.5.0', '1.4.99')).toBeGreaterThan(0);
    });
    it('handles major bumps', () => {
        expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    });
    it('pre-release is older than base', () => {
        expect(compareSemver('1.5.0-dev.1', '1.5.0')).toBeLessThan(0);
        expect(compareSemver('1.5.0', '1.5.0-dev.1')).toBeGreaterThan(0);
    });
});

describe('checkUpdate', () => {
    it('returns update_available=true when latest > installed', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ version: '1.5.0' });
        const r = await checkUpdate(httpGetJson, '1.4.0');
        expect(r.installed_version).toBe('1.4.0');
        expect(r.latest_version).toBe('1.5.0');
        expect(r.update_available).toBe(true);
        expect(r.update_check_error).toBeNull();
        expect(typeof r.update_check_at).toBe('string');
    });
    it('returns update_available=false when latest == installed', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ version: '1.4.0' });
        const r = await checkUpdate(httpGetJson, '1.4.0');
        expect(r.update_available).toBe(false);
    });
    it('returns update_available=false when latest < installed', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ version: '1.3.0' });
        const r = await checkUpdate(httpGetJson, '1.4.0');
        expect(r.update_available).toBe(false);
    });
    it('throws when response missing version', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ name: 'x' });
        await expect(checkUpdate(httpGetJson, '1.4.0')).rejects.toThrow(/missing version/);
    });
    it('throws when version is not a string', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ version: 140 });
        await expect(checkUpdate(httpGetJson, '1.4.0')).rejects.toThrow(/missing version/);
    });
    it('propagates httpGetJson errors', async () => {
        const httpGetJson = jest.fn().mockRejectedValue(new Error('HTTP 404'));
        await expect(checkUpdate(httpGetJson, '1.4.0')).rejects.toThrow(/HTTP 404/);
    });
});

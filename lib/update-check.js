'use strict';

const NPM_LATEST_URL = 'https://registry.npmjs.org/node-red-contrib-octopus-intelligent/latest';

function compareSemver(a, b) {
    // Strict numeric X.Y.Z with optional pre-release suffix.
    // Pre-release (1.5.0-dev.1) is OLDER than the base release (1.5.0).
    const parse = v => {
        const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
        if (!m) return null;
        return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return 0;
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;
    if (pa.pre && !pb.pre) return -1;
    if (!pa.pre && pb.pre) return 1;
    return 0;
}

async function checkUpdate(httpGetJson, installedVersion) {
    const data = await httpGetJson(NPM_LATEST_URL);
    const latest = data && data.version;
    if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+/.test(latest)) {
        throw new Error('npm registry response missing version');
    }
    return {
        installed_version: installedVersion,
        latest_version: latest,
        update_available: compareSemver(latest, installedVersion) > 0,
        update_check_at: new Date().toISOString(),
        update_check_error: null,
    };
}

module.exports = { checkUpdate, compareSemver, NPM_LATEST_URL };

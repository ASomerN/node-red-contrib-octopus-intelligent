module.exports = {
    testEnvironment: 'node',
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'octopus-intelligent.js',
        'lib/**/*.js',
        '!node_modules/**',
        '!coverage/**',
        '!test-mocks.js'
    ],
    testMatch: [
        '**/__tests__/**/*.test.js',
        '**/?(*.)+(spec|test).js'
    ],
    coverageThreshold: {
        global: { branches: 70, functions: 70, lines: 70, statements: 70 }
    },
    verbose: true
};

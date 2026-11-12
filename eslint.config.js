const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Style-level findings this codebase does not follow.
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
  'preserve-caught-error': 'off'
};

module.exports = [
  { ignores: ['node_modules/**', 'mac-app/native/.build/**', '**/*.app/**', 'chrome-extension/whatsapp-sync/vendor/**'] },
  {
    files: ['mac-app/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules
  },
  {
    // UI tests pass callbacks that run inside the page and use its globals.
    files: ['scripts/test-*.js', 'scripts/bench-*.js', 'scripts/helpers/*.js', 'scripts/css-snapshot.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'no-undef': 'off' }
  },
  {
    files: ['chrome-extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      // collector.js defines TradeWhatsAppCollector for content.js; wa-page.js also exports for Node tests.
      globals: { ...globals.browser, ...globals.webextensions, TradeWhatsAppCollector: 'readonly', module: 'readonly' }
    },
    rules
  },
  {
    // Every inline <script> of trade-order-system.html, extracted by scripts/lint.js and linted as one script.
    files: ['.lint/trade-order-system.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      ...rules,
      // A top-level function nobody calls is dead code and fails the lint. nativeDialog is the one
      // exception: only the Mac shell calls it. A function that only a test calls does not belong
      // here: the test should call what the page calls.
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^nativeDialog$'
      }]
    }
  }
];

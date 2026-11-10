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
    files: ['scripts/test-*.js', 'scripts/bench-*.js', 'scripts/helpers/*.js'],
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
      // A top-level function nobody calls is dead code and fails the lint. The names below are the
      // page's entry points that only something outside the page calls: the Mac shell (nativeDialog)
      // and the regression tests (the rest). Add a name here only for a caller of that kind.
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^(nativeDialog|primaryOrderShipment|calendarEventsForMonth|customerFieldsFromCombinedPaste|normalizeAiCustomerFields)$'
      }]
    }
  }
];

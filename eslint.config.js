const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Style-level findings; reported, not blocking.
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
  'preserve-caught-error': 'off',
  'no-useless-assignment': 'warn'
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
    // The inline <script> of trade-order-system.html, extracted by scripts/lint.js.
    files: ['.lint/trade-order-system.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
    // Several unused helpers are still exercised by regression tests; report them until they are cleaned up.
    rules: { ...rules, 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  }
];

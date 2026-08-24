const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Official Vercel project configuration allowed top-level keys
// Schema: https://openapi.vercel.sh/vercel.json (additionalProperties: false)
const ALLOWED_VERCEL_JSON_KEYS = new Set([
  '$schema',
  'buildCommand',
  'devCommand',
  'installCommand',
  'outputDirectory',
  'public',
  'framework',
  'regions',
  'cleanUrls',
  'trailingSlash',
  'headers',
  'redirects',
  'rewrites',
  'crons',
  'ignoreCommand',
  'git',
  'github',
  'sourceFilesOutsideRootDirectory',
  'functions',
  'overrides'
]);

const FORBIDDEN_VERCEL_JSON_KEYS = ['engines', 'env'];

const REPO_ROOT = path.resolve(__dirname, '..');

const VERCEL_JSON_PATHS = [
  'vercel.json',
  'mgk-frontend/vercel.json',
  'mgk-frontend/apps/web/vercel.json'
];

test('vercel.json files follow official Vercel schema without forbidden keys', async (t) => {
  for (const relPath of VERCEL_JSON_PATHS) {
    const fullPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    await t.test(`validates ${relPath}`, () => {
      const raw = fs.readFileSync(fullPath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        assert.fail(`${relPath} is not valid JSON: ${err.message}`);
      }

      assert.ok(typeof parsed === 'object' && parsed !== null, `${relPath} must be a JSON object`);

      // Check forbidden keys explicitly
      for (const forbidden of FORBIDDEN_VERCEL_JSON_KEYS) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(parsed, forbidden),
          false,
          `${relPath} must not contain forbidden key "${forbidden}" (causes Vercel deployment error)`
        );
      }

      // Check all keys against allowed schema keys
      const keys = Object.keys(parsed);
      for (const key of keys) {
        assert.ok(
          ALLOWED_VERCEL_JSON_KEYS.has(key),
          `${relPath} contains illegal key "${key}". Allowed keys: ${Array.from(ALLOWED_VERCEL_JSON_KEYS).join(', ')}`
        );
      }
    });
  }
});

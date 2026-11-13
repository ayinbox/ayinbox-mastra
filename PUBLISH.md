# Publishing @ayinbox/mastra

The package is published to npm from GitHub Actions with npm trusted publishing (OIDC). No npm token is stored anywhere.

## One-time setup (a person does this once)

1. **The `@ayinbox` npm organization must exist.** Sign in at https://www.npmjs.com with the account that will own the package, open "Add Organization", and create `ayinbox` (the free plan is enough for public packages). Every maintainer needs two-factor authentication on their npm account.
2. **First publish by hand.** npm only lets you configure a trusted publisher for a package that already exists, so the first version goes up from a maintainer's machine:

   ```bash
   git clone git@github.com:ayinbox/ayinbox-mastra.git
   cd ayinbox-mastra
   npm ci
   npm run typecheck && npm run build && npm test
   npm login
   npm publish --access public
   ```

   The local publish has no provenance statement (that needs a CI run). Every later version gets one through the workflow.
3. **Configure the trusted publisher.** On https://www.npmjs.com/package/@ayinbox/mastra open Settings, then "Trusted Publisher", choose GitHub Actions and enter:
   - Organization or user: `ayinbox`
   - Repository: `ayinbox-mastra`
   - Workflow filename: `release.yml`
   - Environment: `npm`
4. **Create the `npm` environment** in the GitHub repository (Settings, Environments, New environment, `npm`). Add required reviewers there if a release should wait for approval.
5. Optional, once the workflow has published a version: in the package's npm settings, set "Publishing access" to require two-factor authentication and disallow tokens, so only the workflow can publish.

## Every release after that

1. Update `version` in `package.json` and `VERSION` in `src/version.ts` (a test checks they agree), and add the entry to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs the typecheck, build and tests, and publishes with provenance.

When the package is on npm, change the install section of `README.md` to `npm install @ayinbox/mastra @mastra/core`.

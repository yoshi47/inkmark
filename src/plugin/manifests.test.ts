import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Nothing in this repo imports the plugin manifests, and neither host's validator
// (`claude plugin validate`, Codex's `validate_plugin.py`) runs in CI. This file is the only
// automated thing standing between a manifest edit and a plugin that will not install.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Mirrors of what Codex's validator accepts. Anything outside these sets is a hard reject
// at install time, so a typo like `defaultPrompts` must fail here rather than in the field.
const CODEX_KEYS = new Set([
  'id',
  'name',
  'version',
  'description',
  'skills',
  'apps',
  'mcpServers',
  'interface',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);
const CODEX_INTERFACE_KEYS = new Set([
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
  'capabilities',
  'websiteURL',
  'privacyPolicyURL',
  'termsOfServiceURL',
  'brandColor',
  'composerIcon',
  'logo',
  'logoDark',
  'screenshots',
  'defaultPrompt',
  'default_prompt',
]);
const CODEX_REQUIRED_INTERFACE_FIELDS = [
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
];
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function readManifest(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(REPO_ROOT + relativePath, 'utf8')) as Record<string, unknown>;
}

function firstPluginName(marketplace: Record<string, unknown>): unknown {
  const plugins = marketplace['plugins'];
  if (!Array.isArray(plugins)) throw new Error('marketplace `plugins` must be an array');
  const first = plugins[0] as Record<string, unknown> | undefined;
  if (first === undefined) throw new Error('marketplace `plugins` is empty');
  return first['name'];
}

function skillFrontmatter(relativePath: string): Record<string, unknown> {
  const contents = readFileSync(REPO_ROOT + relativePath, 'utf8');
  const end = contents.indexOf('\n---', 4);
  if (!contents.startsWith('---\n') || end === -1) {
    throw new Error(`${relativePath} has no closed YAML frontmatter`);
  }
  return parseYaml(contents.slice(4, end)) as Record<string, unknown>;
}

const claude = readManifest('.claude-plugin/plugin.json');
const codex = readManifest('.codex-plugin/plugin.json');
const claudeMarket = readManifest('.claude-plugin/marketplace.json');
const codexMarket = readManifest('.agents/plugins/marketplace.json');
const codexInterface = codex['interface'] as Record<string, unknown>;

describe('plugin manifests', () => {
  it.each(['name', 'version', 'description'])('agrees on `%s` across both hosts', (field) => {
    expect(codex[field]).toBe(claude[field]);
  });

  it('carries a strict-semver version', () => {
    expect(codex['version']).toMatch(SEMVER);
  });

  it('identifies its author the way Codex requires', () => {
    const author = codex['author'] as Record<string, unknown>;
    expect(author['name']).toEqual(expect.any(String));
    expect(author['name']).not.toBe('');
    expect(author['url']).toMatch(/^https:\/\/\S+$/);
  });

  it('uses only fields Codex accepts', () => {
    expect(Object.keys(codex).filter((key) => !CODEX_KEYS.has(key))).toEqual([]);
    expect(Object.keys(codexInterface).filter((key) => !CODEX_INTERFACE_KEYS.has(key))).toEqual([]);
  });

  it('points Codex at the shared skills directory', () => {
    // Codex takes one path string covering every subdirectory under it, where Claude takes an
    // array naming each skill (`["./skills/inkmark"]`). Only the normalised value is contractual,
    // so assert on that rather than on one spelling of it.
    expect(String(codex['skills']).replace(/^\.\//, '').replace(/\/$/, '')).toBe('skills');
    expect(existsSync(REPO_ROOT + 'skills/inkmark/SKILL.md')).toBe(true);
  });

  it('points Claude at skill directories that exist', () => {
    const skills = claude['skills'] as string[];
    expect(skills).not.toHaveLength(0);
    for (const skill of skills) {
      expect(existsSync(REPO_ROOT + skill + '/SKILL.md')).toBe(true);
    }
  });

  it('ships a skill whose frontmatter Codex will load', () => {
    const frontmatter = skillFrontmatter('skills/inkmark/SKILL.md');
    for (const field of ['name', 'description']) {
      expect(frontmatter[field]).toEqual(expect.any(String));
      expect(frontmatter[field]).not.toBe('');
    }
    // Either spelling being true takes the skill out of the model's reach, which would leave the
    // plugin installable but inert.
    expect(frontmatter['disable-model-invocation'] ?? false).toBe(false);
    expect(frontmatter['disable_model_invocation'] ?? false).toBe(false);
  });

  it('carries the interface metadata Codex requires', () => {
    for (const field of CODEX_REQUIRED_INTERFACE_FIELDS) {
      expect(codexInterface[field]).toEqual(expect.any(String));
      expect(codexInterface[field]).not.toBe('');
    }

    const capabilities = codexInterface['capabilities'] as unknown[];
    expect(capabilities).not.toHaveLength(0);
    for (const capability of capabilities) {
      expect(capability).toEqual(expect.any(String));
      expect(capability).not.toBe('');
    }

    const prompts = codexInterface['defaultPrompt'] as unknown[];
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const prompt of prompts) {
      expect(prompt).toEqual(expect.any(String));
      expect((prompt as string).length).toBeLessThanOrEqual(128);
    }
  });

  it('names the same plugin in both marketplaces', () => {
    expect(firstPluginName(claudeMarket)).toBe(claude['name']);
    expect(firstPluginName(codexMarket)).toBe(codex['name']);
  });
});

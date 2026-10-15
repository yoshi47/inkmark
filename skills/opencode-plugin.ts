/**
 * OpenCode plugin for inkmark.
 *
 * OpenCode discovers skills in `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`
 * and `.opencode/skills`, so a skill that ships inside a tool's own repository stays invisible
 * until something registers it. This plugin registers `skills/inkmark/SKILL.md` with OpenCode's
 * skill registry — which is what lets the agent read, reply to, resolve, and propose edits on the
 * comments inkmark keeps in a Markdown file.
 *
 * Install:
 *
 *     opencode plugin add 'github:yoshi47/inkmark#main::path:skills'
 *
 * Why this file and `skills/package.json` sit in `skills/` rather than in a directory of their own:
 * OpenCode has no manifest that points at a skill. It reaches one by loading a plugin, and a plugin
 * is installed as the package its entrypoint resolves from. A `github:…#::path:skills` selection
 * installs that one directory and nothing beside it, so a plugin in a sibling directory could not
 * read the skill at run time. The skill has to live inside the package that gets installed, so the
 * skills directory *is* the package — and Claude's and Codex's manifests keep pointing at
 * `./skills/inkmark`, which needs no change.
 *
 * Why a plain object instead of `Plugin.define()` from `@opencode/plugin`: the loader only needs a
 * default export carrying an `id` and a `setup`, so importing nothing at runtime keeps this plugin
 * dependency-free — nothing to install, and nothing to break when that package is renamed or its
 * version drifts from the OpenCode that loads it. The few types it needs are declared below.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory name, the frontmatter `name`, and the id OpenCode keys the skill by, all agree. */
const SKILL_ID = 'inkmark';

const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), SKILL_ID, 'SKILL.md');

/** `Skill.Info` from `@opencode/schema`, narrowed to the fields this plugin sets. */
interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
  autoinvoke?: boolean;
}

interface SkillEditor {
  add(skill: Skill): void;
  update(id: string, update: (skill: Skill) => void): void;
}

interface PluginContext {
  skill: { transform(callback: (editor: SkillEditor) => void): Promise<unknown> };
}

/**
 * Reads `description:` out of SKILL.md's frontmatter.
 *
 * Hand-rolled rather than pulling in a YAML parser: this plugin is dependency-free by design, and
 * the only field OpenCode needs is one scalar that is either inline or a `>`/`|` block. Inside a
 * block, a blank line ends a paragraph and the lines of a paragraph join with a space for `>` (a
 * newline for `|`) — that folded/literal rule is the whole parser required here.
 *
 * Throwing rather than falling back: a skill with no description is never advertised, so a
 * frontmatter edit that breaks this has to fail loudly instead of leaving the plugin installed
 * and inert.
 */
function readDescription(frontmatter: string): string {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.startsWith('description:'));
  if (start === -1) throw new Error(`SKILL.md frontmatter has no description: ${SKILL_PATH}`);

  const specifier = lines[start]?.slice('description:'.length).trim() ?? '';
  if (!['>', '>-', '|', '|-'].includes(specifier)) {
    if (specifier === '') throw new Error(`SKILL.md has an empty description: ${SKILL_PATH}`);
    return specifier.replace(/^['"]|['"]$/g, '');
  }

  const paragraphs: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    // An unindented line is the next frontmatter key, so the block has ended.
    if (line !== '' && !line.startsWith(' ')) break;
    if (line === '') {
      if (paragraphs.length > 0) paragraphs.push([]);
      continue;
    }
    if (paragraphs.length === 0) paragraphs.push([]);
    paragraphs[paragraphs.length - 1]?.push(line.trim());
  }

  const separator = specifier.startsWith('>') ? ' ' : '\n';
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(separator))
    .join('\n');
}

/** Reads SKILL.md and turns it into the skill OpenCode expects. */
function readSkill(): Skill {
  const contents = readFileSync(SKILL_PATH, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (frontmatter === null) throw new Error(`SKILL.md has no frontmatter: ${SKILL_PATH}`);

  // The body, without the frontmatter, is what reaches the model — the same shape OpenCode
  // uses for the skills it discovers on disk itself.
  const body = contents.slice(frontmatter[0].length).replace(/^\r?\n/, '');

  return {
    id: SKILL_ID,
    name: SKILL_ID,
    description: readDescription(frontmatter[1] ?? ''),
    path: SKILL_PATH,
    content: body,
  };
}

export default {
  id: SKILL_ID,
  async setup(context: PluginContext): Promise<void> {
    const skill = readSkill();
    await context.skill.transform((editor) => {
      editor.add(skill);
      // Set explicitly: `autoinvoke` is what puts the skill in the list the model picks from, and
      // a transform-added skill is not guaranteed to inherit whatever file-discovered ones get.
      editor.update(SKILL_ID, (current) => {
        current.autoinvoke = true;
      });
    });
  },
};

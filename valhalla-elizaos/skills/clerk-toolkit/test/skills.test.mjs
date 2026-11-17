import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearClerkCatalogCache,
  loadClerkCatalog,
  parseSkillFrontmatter,
  readClerkSkill,
  searchClerkSkills,
  selectClerkSkills,
} from '../lib.mjs';

const SKILLS_ROOT = path.resolve(import.meta.dirname, '..', 'skills');

test('loads all 20 Clerk skills from the vendored tree', async () => {
  const catalog = await loadClerkCatalog({ skillsRoot: SKILLS_ROOT });
  assert.equal(catalog.length, 20);
  assert.equal(catalog[0].name, 'clerk');
  assert.equal(new Set(catalog.map((skill) => skill.name)).size, 20);
  for (const skill of catalog) {
    assert.match(skill.name, /^clerk(?:-[a-z0-9]+)*$/);
    assert.ok(skill.description.length > 20, `${skill.name} has a description`);
    assert.ok(skill.files.includes('SKILL.md'));
    assert.ok(!skill.files.some((file) => file.startsWith('.git')));
  }
  const nextjs = catalog.find((skill) => skill.name === 'clerk-nextjs-patterns');
  assert.ok(nextjs.references.includes('references/middleware-strategies.md'));
});

test('parses plain and folded YAML descriptions', () => {
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: clerk-test\ndescription: A plain line\n---\n# x'),
    { name: 'clerk-test', description: 'A plain line' },
  );
  const folded = parseSkillFrontmatter(
    '---\nname: clerk-test\ndescription: >-\n  first line\n  second line\nlicense: MIT\n---\n',
  );
  assert.equal(folded.description, 'first line second line');
  assert.equal(folded.license, 'MIT');
});

test('selects the right framework and feature skill', async () => {
  const catalog = await loadClerkCatalog({ skillsRoot: SKILLS_ROOT });
  const cases = [
    ['Add Clerk auth to my Next.js app', 'clerk-nextjs-patterns'],
    ['Clerk middleware route protection', 'clerk-nextjs-patterns'],
    ['React Router loaders with Clerk', 'clerk-react-router-patterns'],
    ['Add Clerk to a Vue app with Pinia', 'clerk-vue-patterns'],
    ['Nuxt server middleware auth', 'clerk-nuxt-patterns'],
    ['Astro island sign-in', 'clerk-astro-patterns'],
    ['TanStack Start createServerFn guard', 'clerk-tanstack-patterns'],
    ['Clerk Expo React Native auth', 'clerk-expo'],
    ['Chrome extension syncHost auth', 'clerk-chrome-extension-patterns'],
    ['Native Android Kotlin auth', 'clerk-android'],
    ['iOS SwiftUI ClerkKit', 'clerk-swift'],
    ['Set up organizations and RBAC', 'clerk-orgs'],
    ['Clerk billing pricing table', 'clerk-billing'],
    ['Clerk webhooks user.created', 'clerk-webhooks'],
    ['Playwright Clerk sign-in test', 'clerk-testing'],
    ['Custom Clerk sign-in UI', 'clerk-custom-ui'],
    ['Clerk backend REST API endpoint', 'clerk-backend-api'],
    ['Clerk CLI env pull', 'clerk-cli'],
    ['Add Clerk authentication', 'clerk-setup'],
    ['React useUser hook', 'clerk-react-patterns'],
  ];
  for (const [request, expected] of cases) {
    assert.equal(
      selectClerkSkills(request, catalog, 1)[0]?.name,
      expected,
      request,
    );
  }
  assert.equal(selectClerkSkills('hello there', catalog, 1)[0]?.name, 'clerk');
  assert.equal(
    selectClerkSkills('exactly clerk-billing please', catalog, 1)[0]?.name,
    'clerk-billing',
  );
});

test('searches names and descriptions', async () => {
  const catalog = await loadClerkCatalog({ skillsRoot: SKILLS_ROOT });
  assert.equal(searchClerkSkills('billing', catalog)[0].name, 'clerk-billing');
  assert.equal(searchClerkSkills('playwright', catalog)[0].name, 'clerk-testing');
  assert.ok(
    searchClerkSkills('organizations', catalog).some(
      (skill) => skill.name === 'clerk-orgs',
    ),
  );
});

test('reads SKILL.md and a reference without escaping the skill directory', async () => {
  const skill = await readClerkSkill('clerk-nextjs-patterns', {
    skillsRoot: SKILLS_ROOT,
  });
  assert.equal(skill.file, 'SKILL.md');
  assert.match(skill.content, /name: clerk-nextjs-patterns/);

  const reference = await readClerkSkill('clerk-nextjs-patterns', {
    file: 'references/middleware-strategies.md',
    skillsRoot: SKILLS_ROOT,
  });
  assert.equal(reference.file, 'references/middleware-strategies.md');
  assert.match(reference.content, /Route Protection/);

  for (const file of [
    '../package.json',
    '/etc/passwd',
    '.env',
    'references/../../package.json',
    'references/%2e%2e/package.json',
    'references/file.exe',
  ]) {
    await assert.rejects(
      () => readClerkSkill('clerk-nextjs-patterns', { file, skillsRoot: SKILLS_ROOT }),
      (error) => ['SKILL_FILE_FORBIDDEN', 'SKILL_FILE_NOT_FOUND'].includes(error.code),
      file,
    );
  }

  await assert.rejects(
    () => readClerkSkill('../../etc', { skillsRoot: SKILLS_ROOT }),
    { code: 'UNKNOWN_CLERK_SKILL' },
  );
  await assert.rejects(
    () => readClerkSkill('clerk-not-real', { skillsRoot: SKILLS_ROOT }),
    { code: 'UNKNOWN_CLERK_SKILL' },
  );
});

test('fails closed when the skills tree is missing or invalid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'clerk-empty-'));
  try {
    clearClerkCatalogCache();
    await assert.rejects(
      () => loadClerkCatalog({ skillsRoot: root }),
      { code: 'SKILLS_NOT_INSTALLED' },
    );
    await mkdir(path.join(root, 'clerk'), { recursive: true });
    await writeFile(path.join(root, 'clerk', 'SKILL.md'), '# no frontmatter\n');
    clearClerkCatalogCache();
    await assert.rejects(
      () => loadClerkCatalog({ skillsRoot: root }),
      { code: 'SKILLS_NOT_INSTALLED' },
    );
  } finally {
    clearClerkCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

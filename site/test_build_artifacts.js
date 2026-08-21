#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  discoverArtifacts,
  parseLearningPaths,
  parseReadme,
  parseRoadmap,
} = require('./build.js');
const {
  learningPathDestination,
  rebuildIndex,
  resultIndexForEnter,
  search,
} = require('./cmdpalette.js');

function loadContentSource() {
  const context = {
    URL,
    window: {
      location: {
        hostname: 'localhost',
        href: 'http://localhost/site/lesson.html',
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'content-source.js'), 'utf8'),
    context
  );
  return context.window.AIFSContentSource;
}

function writeMarkdown(file, { name, description, version }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version}`,
    'license: MIT',
    'tags: [skills, testing]',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'));
}

test('site discovery emits one bundle linked to SKILL.md and preserves flat records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-site-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputs = path.join(root, 'phases', '14-agent-engineering', '22-skill-runtime', 'outputs');
  const flat = path.join(outputs, 'skill-flat-reviewer.md');
  writeMarkdown(flat, {
    name: 'flat-reviewer',
    description: 'Review a flat artifact.',
    version: '1.0.0',
  });
  const bundle = path.join(outputs, 'release-gate');
  writeMarkdown(path.join(bundle, 'SKILL.md'), {
    name: 'release-gate',
    description: 'Gate a release.',
    version: '2.1.0',
  });
  writeMarkdown(path.join(bundle, 'references', 'guide.md'), {
    name: 'nested-guide',
    description: 'Not a second artifact.',
    version: '1.0.0',
  });
  fs.mkdirSync(path.join(bundle, 'scripts'));
  fs.writeFileSync(path.join(bundle, 'scripts', 'check.py'), "print('ok')\n");

  const artifacts = discoverArtifacts(root);

  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts[0], {
    kind: 'skill',
    name: 'flat-reviewer',
    description: 'Review a flat artifact.',
    tags: ['skills', 'testing'],
    phase: 14,
    lesson: 22,
    lessonPath: 'phases/14-agent-engineering/22-skill-runtime',
    file: 'phases/14-agent-engineering/22-skill-runtime/outputs/skill-flat-reviewer.md',
  });
  assert.deepEqual(artifacts[1], {
    kind: 'skill',
    name: 'release-gate',
    description: 'Gate a release.',
    tags: ['skills', 'testing'],
    version: '2.1.0',
    license: 'MIT',
    phase: 14,
    lesson: 22,
    lessonPath: 'phases/14-agent-engineering/22-skill-runtime',
    file: 'phases/14-agent-engineering/22-skill-runtime/outputs/release-gate/SKILL.md',
    bundle: true,
    bundlePath: 'phases/14-agent-engineering/22-skill-runtime/outputs/release-gate',
    files: ['SKILL.md', 'references/guide.md', 'scripts/check.py'],
  });
});

test('site discovery rejects bundle symlinks instead of following escapes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-site-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(
    root,
    'phases',
    '14-agent-engineering',
    '22-skill-runtime',
    'outputs',
    'release-gate'
  );
  writeMarkdown(path.join(bundle, 'SKILL.md'), {
    name: 'release-gate',
    description: 'Gate a release.',
    version: '2.1.0',
  });
  const outside = path.join(root, 'private.txt');
  fs.writeFileSync(outside, 'do not read\n');
  fs.mkdirSync(path.join(bundle, 'references'));
  fs.symlinkSync(outside, path.join(bundle, 'references', 'private.txt'));

  assert.throws(
    () => discoverArtifacts(root),
    /Skill bundle contains a symlink/
  );
});

test('site discovery rejects a bundle reached through an escaping parent symlink', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-site-artifacts-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const root = path.join(tempRoot, 'workspace');
  const lesson = path.join(root, 'phases', '14-agent-engineering', '22-skill-runtime');
  fs.mkdirSync(lesson, { recursive: true });
  const outsideOutputs = path.join(tempRoot, 'outside-outputs');
  writeMarkdown(path.join(outsideOutputs, 'release-gate', 'SKILL.md'), {
    name: 'release-gate',
    description: 'Gate a release.',
    version: '2.1.0',
  });
  fs.symlinkSync(outsideOutputs, path.join(lesson, 'outputs'), 'dir');

  assert.throws(
    () => discoverArtifacts(root),
    /Skill bundle escapes the repository/
  );
});

test('lesson output merging preserves bundle identity and unmatched live files', () => {
  const source = loadContentSource();
  const lesson = 'phases/13-agent-development/22-skill-runtime';
  const outputs = `${lesson}/outputs`;
  const liveReport = {
    name: 'report.json',
    path: `${outputs}/report.json`,
  };
  const live = [
    { name: 'skill-flat-reviewer.md', path: `${outputs}/skill-flat-reviewer.md` },
    { name: 'release-gate', path: `${outputs}/release-gate`, type: 'dir' },
    liveReport,
  ];
  const flat = {
    kind: 'skill',
    name: 'flat-reviewer',
    lessonPath: lesson,
    file: `${outputs}/skill-flat-reviewer.md`,
  };
  const bundle = {
    kind: 'skill',
    name: 'release-gate',
    lessonPath: lesson,
    file: `${outputs}/release-gate/SKILL.md`,
    bundle: true,
    bundlePath: `${outputs}/release-gate`,
    files: ['SKILL.md', 'references/guide.md', 'scripts/check.py'],
  };
  const artifacts = [
    flat,
    bundle,
    { kind: 'mission', name: 'mission', lessonPath: lesson, file: `${lesson}/mission.md` },
    {
      kind: 'skill',
      name: 'other-lesson',
      lessonPath: 'phases/13-agent-development/24-other',
      file: 'phases/13-agent-development/24-other/outputs/other/SKILL.md',
    },
  ];

  const merged = source.mergeLessonOutputs(lesson, live, artifacts);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], flat);
  assert.equal(merged[1], bundle);
  assert.equal(merged[2], liveReport);
  assert.equal(merged[1].files, bundle.files);
  assert.deepEqual(Array.from(merged, entry => entry.name), [
    'flat-reviewer',
    'release-gate',
    'report.json',
  ]);

  const withoutDirectoryListing = source.mergeLessonOutputs(lesson, [], artifacts);
  assert.equal(withoutDirectoryListing.length, 2);
  assert.equal(withoutDirectoryListing[0], flat);
  assert.equal(withoutDirectoryListing[1], bundle);
});

test('learning path manifests preserve route order and use canonical lesson titles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-learning-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'learning-paths'), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-paths', 'agent-skills.json'), JSON.stringify({
    id: 'agent-skills',
    title: 'Agent Skills',
    summary: 'Build portable skills that agents can discover and invoke.',
    estimatedMinutes: 570,
    lessons: [
      { order: 1, path: 'phases/13-tools-and-protocols/22-skills-and-agent-sdks', title: 'Stale title' },
      {
        path: 'phases/13-tools-and-protocols/24-skill-discovery-and-progressive-disclosure',
        prerequisitePaths: ['phases/13-tools-and-protocols/22-skills-and-agent-sdks'],
      },
    ],
    optionalLessons: [
      { path: 'phases/13-tools-and-protocols/23-capstone-tool-ecosystem' },
    ],
  }));
  const github = 'https://github.com/rohitg00/ai-engineering-from-scratch/tree/main/';
  const phases = [{
    id: 13,
    name: 'Tools and Protocols',
    lessons: [
      { name: 'Skills and Agent SDKs', type: 'Build', lang: 'Python', url: github + 'phases/13-tools-and-protocols/22-skills-and-agent-sdks/' },
      { name: 'Tool Ecosystem Capstone', type: 'Capstone', lang: 'Python', url: github + 'phases/13-tools-and-protocols/23-capstone-tool-ecosystem/' },
      { name: 'Skill Discovery and Progressive Disclosure', type: 'Learn', lang: 'Python', url: github + 'phases/13-tools-and-protocols/24-skill-discovery-and-progressive-disclosure/' },
    ],
  }];

  const [learningPath] = parseLearningPaths(root, phases);

  assert.equal(learningPath.id, 'agent-skills');
  assert.deepEqual(learningPath.lessons.map(entry => entry.path), [
    'phases/13-tools-and-protocols/22-skills-and-agent-sdks',
    'phases/13-tools-and-protocols/24-skill-discovery-and-progressive-disclosure',
  ]);
  assert.deepEqual(learningPath.lessons.map(entry => entry.title), [
    'Skills and Agent SDKs',
    'Skill Discovery and Progressive Disclosure',
  ]);
  assert.equal(learningPath.lessons[0].required, true);
  assert.deepEqual(learningPath.lessons[1].prerequisitePaths, [
    'phases/13-tools-and-protocols/22-skills-and-agent-sdks',
  ]);
  assert.equal(learningPath.optionalLessons[0].required, false);
});

test('repository Agent Skills path routes 22 to 24 and keeps 23 optional', () => {
  const root = path.resolve(__dirname, '..');
  const roadmap = parseRoadmap(fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8'));
  const phases = parseReadme(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), roadmap);
  const learningPath = parseLearningPaths(root, phases).find(entry => entry.id === 'agent-skills');

  assert.ok(learningPath);
  assert.deepEqual(learningPath.lessons.map(entry => entry.lesson), [22, 24, 25, 26, 27]);
  assert.deepEqual(learningPath.optionalLessons.map(entry => entry.lesson), [23]);
  assert.equal(learningPath.lessons[0].path, 'phases/13-tools-and-protocols/22-skills-and-agent-sdks');
  assert.equal(learningPath.lessons[1].path, 'phases/13-tools-and-protocols/24-skill-discovery-and-progressive-disclosure');
  assert.deepEqual(learningPath.lessons[3].prerequisitePaths, [
    'phases/13-tools-and-protocols/15-mcp-security-tool-poisoning',
    'phases/13-tools-and-protocols/25-skill-invocation-and-routing',
  ]);
});

test('learning path query and Enter fallback open the first result predictably', () => {
  assert.equal(
    learningPathDestination('phases/13-tools-and-protocols/22-skills-and-agent-sdks', 'agent-skills'),
    'lesson.html?path=phases%2F13-tools-and-protocols%2F22-skills-and-agent-sdks&learningPath=agent-skills'
  );
  assert.equal(resultIndexForEnter(-1, 5), 0);
  assert.equal(resultIndexForEnter(3, 5), 3);
  assert.equal(resultIndexForEnter(-1, 0), -1);
});

test('exact Agent Skills search ranks the focused path before individual lessons', () => {
  global.LEARNING_PATHS = [{
    id: 'agent-skills',
    title: 'Agent Skills Engineering',
    summary: 'A focused route.',
    estimatedMinutes: 570,
    lessons: [{ path: 'phases/13-tools-and-protocols/22-skills-and-agent-sdks' }],
  }];
  global.PHASES = [{
    id: 13,
    name: 'Tools and Protocols',
    lessons: [{
      name: 'Agent Skills: Portable Contract and Runtime Boundary',
      summary: 'Learn agent skills.',
      url: 'https://github.com/rohitg00/ai-engineering-from-scratch/tree/main/phases/13-tools-and-protocols/22-skills-and-agent-sdks/',
    }],
  }];

  try {
    rebuildIndex();
    const [first] = search('Agent Skills');
    assert.equal(first.kind, 'learning-path');
    assert.equal(first.url, 'lesson.html?path=phases%2F13-tools-and-protocols%2F22-skills-and-agent-sdks&learningPath=agent-skills');
  } finally {
    delete global.LEARNING_PATHS;
    delete global.PHASES;
    rebuildIndex();
  }
});

test('lesson reader keeps learning-path context and renders a copyable full-depth install', () => {
  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');

  assert.match(lessonHtml, /requestedLearningPathId = params\.get\('learningPath'\)/);
  assert.match(lessonHtml, /Lesson ' \+ \(focusedIndex \+ 1\) \+ ' of ' \+ focusedLessons\.length/);
  assert.match(lessonHtml, /prerequisitePaths: pathEntry/);
  assert.match(lessonHtml, /learningPathPrerequisiteCallout\(nextRequired/);
  assert.match(lessonHtml, /--skill ' \+ skillName \+ ' --full-depth/);
  assert.match(lessonHtml, /class="output-btn output-install-copy"/);
  assert.match(lessonHtml, /Requires a local clone/);
  assert.match(lessonHtml, /git rev-parse --show-toplevel/);
  assert.match(lessonHtml, /lessonQuizCorrectAnswers\[qid\] = q\.correct/);
  assert.doesNotMatch(lessonHtml, /data-correct=/);
  assert.match(lessonHtml, /\$check-understanding/);
  assert.match(lessonHtml, /\/check-understanding/);
});

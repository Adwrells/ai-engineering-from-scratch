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

function createMcpTestDom() {
  const ids = new Map();

  class TestNode {
    constructor(tagName, text = '') {
      this.nodeType = tagName ? 1 : 3;
      this.tagName = tagName ? tagName.toUpperCase() : '';
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.className = '';
      this._id = '';
      this._text = String(text);
      this._innerHtml = '';
    }

    get children() {
      return this.childNodes.filter(child => child.nodeType === 1);
    }

    get firstChild() {
      return this.childNodes[0] || null;
    }

    get id() {
      return this._id;
    }

    set id(value) {
      if (this._id && ids.get(this._id) === this) ids.delete(this._id);
      this._id = String(value || '');
      if (this._id) ids.set(this._id, this);
    }

    get textContent() {
      if (this.nodeType === 3) return this._text;
      return this._text + this.childNodes.map(child => child.textContent).join('');
    }

    set textContent(value) {
      this.childNodes.forEach(child => { child.parentNode = null; });
      this.childNodes = [];
      this._text = String(value ?? '');
      this._innerHtml = '';
    }

    get innerHTML() {
      return this._innerHtml || this.textContent;
    }

    set innerHTML(value) {
      this.childNodes.forEach(child => { child.parentNode = null; });
      this.childNodes = [];
      this._text = '';
      this._innerHtml = String(value ?? '');
    }

    setAttribute(name, value) {
      const normalized = String(value);
      if (name === 'id') this.id = normalized;
      else if (name === 'class') this.className = normalized;
      else this.attributes.set(name, normalized);
    }

    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name === 'class') return this.className || null;
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    }

    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this._text = '';
      this._innerHtml = '';
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index < 0) throw new Error('Cannot remove a node that is not a child');
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatchEvent(event) {
      const normalized = typeof event === 'string' ? { type: event } : event;
      if (!normalized.target) normalized.target = this;
      for (const listener of this.listeners.get(normalized.type) || []) listener.call(this, normalized);
      return true;
    }

    click() {
      this.dispatchEvent({ type: 'click', target: this });
    }
  }

  const document = {
    createElement(tagName) {
      return new TestNode(tagName);
    },
    createTextNode(text) {
      return new TestNode('', text);
    },
    getElementById(id) {
      return ids.get(id) || null;
    },
  };
  document.head = document.createElement('head');

  function el(tag, attrs, kids) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (name === 'class') node.className = value;
      else if (name === 'html') node.innerHTML = value;
      else node.setAttribute(name, value);
    }
    for (const child of kids || []) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function findAll(root, predicate) {
    const matches = [];
    function visit(node) {
      if (predicate(node)) matches.push(node);
      node.childNodes.forEach(visit);
    }
    visit(root);
    return matches;
  }

  return { document, el, findAll };
}

function loadMcpLabLogic() {
  const file = path.join(__dirname, 'figures-mcp.js');
  const source = fs.readFileSync(file, 'utf8');
  const registrationMarker = '\n  LF.register({';
  assert.ok(source.includes(registrationMarker), 'MCP lab registration marker is missing');
  const testExport = `
  window.__MCP_LAB_TEST_API = {
    contractScenarios: contractScenarios,
    transportScenarios: transportScenarios,
    requestScenarios: requestScenarios,
    dispatchScenarios: dispatchScenarios,
    conformanceScenarios: conformanceScenarios,
    reliabilityScenarios: reliabilityScenarios,
    admissionScenarios: admissionScenarios,
    primitiveScenarios: primitiveScenarios,
    retryScenarios: retryScenarios,
    driftScenarios: driftScenarios,
    mergeScenarios: mergeScenarios,
    boundaryScenarios: boundaryScenarios,
    taskScenarios: taskScenarios,
    appScenarios: appScenarios,
    poisonScenarios: poisonScenarios,
    oauthScenarios: oauthScenarios,
    jwksScenarios: jwksScenarios,
    evaluateContract: evaluateContract,
    evaluateTransport: evaluateTransport,
    evaluateRequestScenario: evaluateRequestScenario,
    evaluateDispatch: evaluateDispatch,
    evaluateConformance: evaluateConformance,
    evaluateReliability: evaluateReliability,
    evaluateAdmission: evaluateAdmission,
    evaluatePrimitive: evaluatePrimitive,
    evaluateRetry: evaluateRetry,
    evaluateDrift: evaluateDrift,
    evaluateMerge: evaluateMerge,
    evaluateBoundary: evaluateBoundary,
    evaluateTask: evaluateTask,
    evaluateApp: evaluateApp,
    evaluatePoison: evaluatePoison,
    evaluateOAuth: evaluateOAuth,
    evaluateJwks: evaluateJwks
  };
`;
  const dom = createMcpTestDom();
  const registrations = {};
  const context = {
    window: {
      LF: {
        el: dom.el,
        register(entries) {
          Object.assign(registrations, entries);
        },
      },
    },
    document: dom.document,
  };
  vm.runInNewContext(
    source.replace(registrationMarker, testExport + registrationMarker),
    context,
    { filename: file }
  );
  return {
    ...context.window.__MCP_LAB_TEST_API,
    registeredFigureIds: Object.keys(registrations).sort(),
    document: dom.document,
    renderFigure(id) {
      const host = dom.document.createElement('div');
      assert.equal(typeof registrations[id], 'function', `missing renderer for ${id}`);
      registrations[id](host);
      return host;
    },
    findAll: dom.findAll,
  };
}

function plainMcpValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadLearningPathProgressRuntime(storage) {
  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  const match = lessonHtml.match(/<script id="learningPathProgressRuntime">([\s\S]*?)<\/script>/);
  assert.ok(match, 'lesson reader is missing the learning-path progress runtime');
  const context = { window: { localStorage: storage } };
  vm.runInNewContext(match[1], context, { filename: 'lesson.html#learningPathProgressRuntime' });
  return context.window.AIFSLearningPathProgress;
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    value(key) {
      return values.get(key);
    },
  };
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
  writeMarkdown(path.join(outsideOutputs, 'skill-leaked-reviewer.md'), {
    name: 'leaked-reviewer',
    description: 'This flat artifact must never be ingested.',
    version: '1.0.0',
  });
  fs.symlinkSync(outsideOutputs, path.join(lesson, 'outputs'), 'dir');

  assert.throws(
    () => discoverArtifacts(root),
    /Lesson outputs escapes the repository/
  );
});

test('site discovery rejects an in-repository outputs directory symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-site-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lesson = path.join(root, 'phases', '14-agent-engineering', '22-skill-runtime');
  const sharedOutputs = path.join(root, 'shared-outputs');
  fs.mkdirSync(lesson, { recursive: true });
  writeMarkdown(path.join(sharedOutputs, 'skill-shared-reviewer.md'), {
    name: 'shared-reviewer',
    description: 'This artifact is in the repository but behind a symlink.',
    version: '1.0.0',
  });
  fs.symlinkSync(sharedOutputs, path.join(lesson, 'outputs'), 'dir');

  assert.throws(
    () => discoverArtifacts(root),
    /Lesson outputs must be a regular directory/
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
        order: 2,
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

test('learning path manifests reject duplicate and unresolved prerequisite checks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-learning-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'learning-paths'), { recursive: true });
  const lessonPath = 'phases/13-tools-and-protocols/22-skills-and-agent-sdks';
  const phases = [{
    id: 13,
    name: 'Tools and Protocols',
    lessons: [{
      name: 'Skills and Agent SDKs',
      type: 'Build',
      lang: 'Python',
      url: 'https://github.com/rohitg00/ai-engineering-from-scratch/tree/main/' + lessonPath + '/',
    }],
  }];
  const manifestFile = path.join(root, 'learning-paths', 'agent-skills.json');

  fs.writeFileSync(manifestFile, JSON.stringify({
    id: 'agent-skills',
    prerequisites: [{ id: 'poisoning' }, { id: 'poisoning' }],
    lessons: [{ path: lessonPath, prerequisiteChecks: ['poisoning'] }],
  }));
  assert.throws(
    () => parseLearningPaths(root, phases),
    /repeats prerequisite id: poisoning/
  );

  fs.writeFileSync(manifestFile, JSON.stringify({
    id: 'agent-skills',
    prerequisites: [{ id: 'poisoning' }],
    lessons: [{ path: lessonPath, prerequisiteChecks: ['poisoning-typo'] }],
  }));
  assert.throws(
    () => parseLearningPaths(root, phases),
    /references an unknown prerequisite check: poisoning-typo/
  );
});

test('learning path manifests reject invalid prerequisite path graphs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-learning-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'learning-paths'), { recursive: true });
  const paths = [
    'phases/13-tools-and-protocols/22-skills-and-agent-sdks',
    'phases/13-tools-and-protocols/24-skill-discovery-and-progressive-disclosure',
    'phases/13-tools-and-protocols/25-skill-invocation-and-routing',
  ];
  const github = 'https://github.com/rohitg00/ai-engineering-from-scratch/tree/main/';
  const phases = [{
    id: 13,
    name: 'Tools and Protocols',
    lessons: paths.map((lessonPath, index) => ({
      name: `Lesson ${index + 1}`,
      type: 'Build',
      lang: 'Python',
      url: github + lessonPath + '/',
    })),
  }];
  const manifestFile = path.join(root, 'learning-paths', 'route.json');
  const writeRoute = lessons => fs.writeFileSync(
    manifestFile,
    JSON.stringify({ id: 'route', lessons })
  );

  writeRoute([
    { path: paths[0] },
    { path: paths[1], prerequisitePaths: ['phases/13-tools-and-protocols/99-missing'] },
  ]);
  assert.throws(
    () => parseLearningPaths(root, phases),
    /references an unknown prerequisite path/
  );

  writeRoute([
    { path: paths[0] },
    { path: paths[1], prerequisitePaths: [paths[1]] },
  ]);
  assert.throws(
    () => parseLearningPaths(root, phases),
    /cannot depend on itself/
  );

  writeRoute([
    { path: paths[0], prerequisitePaths: [paths[1]] },
    { path: paths[1] },
  ]);
  assert.throws(
    () => parseLearningPaths(root, phases),
    /has a forward prerequisite/
  );

  writeRoute([
    { path: paths[0], prerequisitePaths: [paths[1]] },
    { path: paths[1], prerequisitePaths: [paths[0]] },
  ]);
  assert.throws(
    () => parseLearningPaths(root, phases),
    /contains a prerequisite cycle/
  );
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
    'phases/13-tools-and-protocols/25-skill-invocation-and-routing',
  ]);
  assert.deepEqual(learningPath.lessons[3].prerequisiteChecks, [
    'tool-poisoning-and-untrusted-instructions',
  ]);
  const poisoningPreflight = learningPath.prerequisites.find(
    entry => entry.id === 'tool-poisoning-and-untrusted-instructions'
  );
  assert.equal(poisoningPreflight.title, 'Tool poisoning and untrusted instructions');
  assert.equal(poisoningPreflight.required, true);
  assert.equal(Object.hasOwn(poisoningPreflight, 'path'), false);
});

test('optional MCP capstone keeps its prerequisite gate in every lesson reader surface', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'learning-paths', 'mcp-engineering.json'), 'utf8'));
  const capstone = manifest.optionalLessons.find(entry => entry.lesson === 23);
  const completedPaths = new Set();
  const progress = loadLearningPathProgressRuntime(createMemoryStorage());
  const isLessonComplete = lessonPath => completedPaths.has(lessonPath);

  assert.ok(capstone);
  assert.equal(capstone.required, false);
  assert.deepEqual(capstone.prerequisitePaths, [
    'phases/13-tools-and-protocols/19-a2a-protocol',
    'phases/13-tools-and-protocols/20-opentelemetry-genai',
  ]);
  assert.equal(progress.canEnter(manifest, capstone, isLessonComplete), false);
  assert.deepEqual(Array.from(progress.unmetPaths(capstone, isLessonComplete)), capstone.prerequisitePaths);
  completedPaths.add(capstone.prerequisitePaths[0]);
  assert.equal(progress.canEnter(manifest, capstone, isLessonComplete), false);
  completedPaths.add(capstone.prerequisitePaths[1]);
  assert.equal(progress.canEnter(manifest, capstone, isLessonComplete), true);

  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  assert.match(lessonHtml, /var focusedEntry = flatLessons\.find\(function \(item\) \{ return item\.path === lessonPath; \}\) \|\| null/);
  assert.match(lessonHtml, /learningPathPrerequisiteCallout\(focusedEntry, 'Required before this lesson'\)/);
  assert.match(lessonHtml, /var optionalLocked = learningPathEntryLocked\(optionalLesson\)/);
  assert.match(
    lessonHtml,
    /class="continue-link' \+ learningPathGateClass\(optionalLesson\)[\s\S]{0,300}learningPathGateAttributes\(optionalLesson\)/
  );
  assert.match(lessonHtml, /optionalLocked \? 'Locked optional capstone: ' : 'Optional capstone: '/);
});

test('Agent Skills knowledge preflight persists per path and gates Lesson 26 deterministically', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'learning-paths', 'agent-skills.json'), 'utf8'));
  const lesson = manifest.lessons.find(entry => entry.lesson === 26);
  const checkId = 'tool-poisoning-and-untrusted-instructions';
  const storage = createMemoryStorage();
  const progress = loadLearningPathProgressRuntime(storage);

  assert.equal(progress.storageKey, 'aifs:learning-path-progress:v1');
  const completedPaths = new Set();
  const isLessonComplete = lessonPath => completedPaths.has(lessonPath);
  assert.equal(progress.canEnter(manifest, lesson, isLessonComplete), false);
  assert.deepEqual(Array.from(progress.unmetPaths(lesson, isLessonComplete)), [
    'phases/13-tools-and-protocols/25-skill-invocation-and-routing',
  ]);
  assert.deepEqual(
    Array.from(progress.unmetChecks(manifest, lesson), check => check.id),
    [checkId]
  );

  assert.equal(progress.confirm(manifest.id, checkId), true);
  assert.equal(progress.canEnter(manifest, lesson, isLessonComplete), false);
  completedPaths.add('phases/13-tools-and-protocols/25-skill-invocation-and-routing');
  assert.equal(progress.canEnter(manifest, lesson, isLessonComplete), true);
  assert.equal(
    storage.value(progress.storageKey),
    JSON.stringify({ version: 1, paths: { 'agent-skills': { checks: { [checkId]: true } } } })
  );

  const restored = loadLearningPathProgressRuntime(storage);
  assert.equal(restored.isConfirmed('agent-skills', checkId), true);
  assert.equal(restored.isConfirmed('model-context-protocol', checkId), false);
  assert.equal(restored.canEnter(manifest, lesson, isLessonComplete), true);
});

test('learning path navigation selects the first actually unmet knowledge check', () => {
  const manifest = {
    id: 'agent-skills',
    prerequisites: [
      { id: 'first', title: 'First check' },
      { id: 'second', title: 'Second check' },
    ],
  };
  const lesson = { prerequisiteChecks: ['first', 'second'] };
  const progress = loadLearningPathProgressRuntime(createMemoryStorage());

  assert.equal(progress.firstUnmetCheckId(manifest, lesson), 'first');
  assert.equal(progress.confirm(manifest.id, 'first'), true);
  assert.equal(progress.firstUnmetCheckId(manifest, lesson), 'second');
});

test('generic course skills dispatch every supported state to an installed owner', () => {
  const root = path.resolve(__dirname, '..');
  const routeOwners = [
    ['LEARNING.md', 'learn'],
    ['MCP-ENGINEERING-LEARNING.md', 'learn-mcp-engineering'],
    ['AGENT-SKILLS-LEARNING.md', 'learn-agent-skills'],
    ['CLAUDE-CERTIFICATION.md', 'claude-certification'],
  ];

  for (const name of ['learn', 'start-learning']) {
    const source = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    const mirror = fs.readFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    const section = source.match(/## Focused Agent Skills handoff\s+([\s\S]*?)(?=\n## |$)/);
    assert.ok(section, `${name} is missing the focused Agent Skills handoff`);
    assert.match(section[1], /AGENT-SKILLS-LEARNING\.md/);
    assert.match(section[1], /learn-agent-skills/);
    assert.match(section[1], /do not (?:copy Agent Skills state into|create) `LEARNING\.md`/);
    const resume = source.match(/## Resume routing across course modes\s+([\s\S]*?)(?=\n## |$)/);
    assert.ok(resume, `${name} is missing cross-route resume handling`);
    for (const [stateFile, owner] of routeOwners) {
      assert.match(
        resume[1],
        new RegExp('`' + stateFile.replace('.', '\\.') + '` belongs to `' + owner + '`'),
        `${name} does not dispatch ${stateFile} to ${owner}`
      );
      assert.ok(fs.existsSync(path.join(root, 'skills', owner, 'SKILL.md')), `${owner} is not installed`);
      assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', owner, 'SKILL.md')), `${owner} mirror is not installed`);
    }
    assert.match(resume[1], /names a route[\s\S]*dispatch to its\s+owner immediately/);
    assert.match(resume[1], /If exactly one route owner remains/);
    assert.match(resume[1], /If two\s+or more route owners remain/);
    assert.match(resume[1], /ask which route to\s+resume/);
    assert.doesNotMatch(resume[1], /MCP-LEARNING\.md|`learn-mcp`/);
    assert.doesNotMatch(source, /learning-paths\/model-context-protocol\.json/);
    assert.equal(source, mirror, `${name} skill mirrors diverged`);

    const genericStart = name === 'learn'
      ? source.indexOf('## Step 0')
      : source.indexOf('If `LEARNING.md` already exists');
    assert.ok(source.indexOf('## Resume routing across course modes') < genericStart);
  }

  assert.ok(fs.existsSync(path.join(root, 'learning-paths', 'mcp-engineering.json')));
  assert.ok(fs.existsSync(path.join(root, 'learning-paths', 'agent-skills.json')));
});

test('course guide shape count matches its six routing bullets in both mirrors', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of [
    path.join(root, 'skills', 'course-guide', 'SKILL.md'),
    path.join(root, '.claude', 'skills', 'course-guide', 'SKILL.md'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    const routing = source.match(/1\. \*\*Interpret the ask\*\*[\s\S]*?(?=\n2\. \*\*Scan the Contents tables\*\*)/);
    assert.ok(routing, `${file} is missing the routing-shape section`);
    assert.match(routing[0], /one of six shapes/);
    assert.equal(Array.from(routing[0].matchAll(/^\s+- \*[^*]+\*/gm)).length, 6);
  }
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
  assert.match(lessonHtml, /prerequisiteChecks: pathEntry/);
  assert.match(lessonHtml, /data-prerequisite-paths/);
  assert.match(lessonHtml, /learningPathEntryLocked/);
  assert.match(lessonHtml, /firstId = linkUnmetLearningPathCheckIds\(link\)\[0\]/);
  assert.match(lessonHtml, /data-learning-path-prerequisite-callout="true"/);
  assert.match(lessonHtml, /function linkUnmetLearningPathPrerequisitePaths\(link\)/);
  assert.match(lessonHtml, /function ensureLearningPathPrerequisiteCallout\(link\)/);
  assert.match(lessonHtml, /var pathCallout = button \? null : ensureLearningPathPrerequisiteCallout\(link\)/);
  assert.match(lessonHtml, /feedbackTarget\.scrollIntoView/);
  assert.match(lessonHtml, /feedbackTarget\.focus\(\)/);
  assert.match(lessonHtml, /nextRequiredLocked \? 'Locked: ' : 'Next: '/);
  assert.doesNotMatch(lessonHtml, /\|\| \{ id: checkId, title: checkId, description: '' \}/);
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

test('MCP lesson labs register modern figures with inspectable protocol outcomes', () => {
  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  const legacyIndex = lessonHtml.indexOf('figures-tools3.js?v=20260821a');
  const mcpIndex = lessonHtml.indexOf('figures-mcp.js?v=20260821a');

  assert.ok(legacyIndex >= 0);
  assert.ok(mcpIndex > legacyIndex);

  const expectedFigureIds = [
    'mcp-tool-call',
    't3-dispatch-loop',
    'tp-client-merge',
    'tp-transport-handshake',
    't3-primitive-sort',
    't3-sampling-flip',
    't3-roots-boundary',
    'tp-task-lifecycle',
    't3-ui-sandbox',
    'tp-tool-poisoning',
    't3-scope-stepup',
    't3-gateway-funnel',
    't3-jwks-rotate',
    'mcp-contract-pipeline',
    'mcp-reliability-race',
    'mcp-registry-admission',
    'mcp-conformance-operations',
  ].sort();
  const logic = loadMcpLabLogic();
  assert.deepEqual(logic.registeredFigureIds, expectedFigureIds);

  for (const figureId of expectedFigureIds) {
    const host = logic.renderFigure(figureId);
    const figures = logic.findAll(host, node => node.tagName === 'FIGURE');
    assert.equal(figures.length, 1, `${figureId} must render one semantic figure`);
    const figure = figures[0];
    const captions = logic.findAll(figure, node => node.tagName === 'FIGCAPTION');
    assert.equal(captions.length, 1, `${figureId} must render one figcaption`);
    assert.ok(captions[0].textContent.trim(), `${figureId} must explain its outcome`);
    const titleId = figure.getAttribute('aria-labelledby');
    assert.ok(titleId && logic.document.getElementById(titleId), `${figureId} must label its figure`);

    const verdict = logic.findAll(figure, node => node.getAttribute && node.getAttribute('class') === 'mcp-lab__verdict')[0];
    assert.equal(verdict.getAttribute('role'), 'status');
    assert.equal(verdict.getAttribute('aria-live'), 'polite');
    assert.equal(verdict.getAttribute('aria-atomic'), 'true');

    const scenarioButtons = logic.findAll(figure, node =>
      node.tagName === 'BUTTON' && String(node.className).split(/\s+/).includes('mcp-lab__scenario')
    );
    assert.ok(scenarioButtons.length > 1, `${figureId} must expose multiple scenarios`);
    assert.equal(scenarioButtons[0].getAttribute('aria-pressed'), 'true');
    assert.equal(scenarioButtons[1].getAttribute('aria-pressed'), 'false');
    scenarioButtons[1].click();
    assert.equal(scenarioButtons[0].getAttribute('aria-pressed'), 'false');
    assert.equal(scenarioButtons[1].getAttribute('aria-pressed'), 'true');

    const action = logic.findAll(figure, node =>
      node.tagName === 'BUTTON' && String(node.className).split(/\s+/).includes('mcp-lab__action')
    )[0];
    const runBefore = figure.getAttribute('data-run');
    action.click();
    assert.notEqual(figure.getAttribute('data-run'), runBefore);
    assert.ok(verdict.getAttribute('data-announced'));
  }

  const styles = logic.document.getElementById('mcp-lab-styles');
  assert.ok(styles, 'rendering must install the MCP lab styles');
  assert.match(styles.textContent, /@media\(max-width:640px\)/);
  assert.match(styles.textContent, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(styles.textContent, /transform:none!important/);
  assert.equal(
    logic.document.head.children.filter(child => child.id === 'mcp-lab-styles').length,
    1,
    'rendering many labs must not duplicate the style element'
  );
});

test('MCP evaluators expose each protocol boundary in its owning scenario', () => {
  const logic = loadMcpLabLogic();
  const byId = (entries, id) => entries.find(entry => entry.id === id);

  const discovery = plainMcpValue(logic.evaluateRequestScenario(byId(logic.requestScenarios, 'discover')));
  assert.equal(discovery.evidence.request.body.method, 'server/discover');
  assert.equal(discovery.evidence.request.body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepEqual(discovery.evidence.request.body.params._meta['io.modelcontextprotocol/clientCapabilities'], { tools: {} });
  assert.equal(discovery.evidence.request.body.params._meta['io.modelcontextprotocol/clientInfo'].name, 'course-host');
  assert.equal(discovery.evidence.request.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(discovery.evidence.request.headers['Mcp-Method'], 'server/discover');
  assert.deepEqual(discovery.evidence.response.body.result.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.evidence.response.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'notes-replica-b');

  const subscription = plainMcpValue(logic.evaluateTransport(byId(logic.transportScenarios, 'listen')));
  assert.equal(subscription.evidence.request.body.method, 'subscriptions/listen');
  assert.equal(subscription.evidence.response.events[0].params._meta['io.modelcontextprotocol/subscriptionId'], 'listen-1');

  const retry = plainMcpValue(logic.evaluateRetry(byId(logic.retryScenarios, 'valid')));
  assert.equal(retry.evidence.firstResponse.result.resultType, 'input_required');
  assert.ok(retry.evidence.firstResponse.result.inputRequests.pick_files);
  assert.ok(retry.evidence.retryRequest.params.inputResponses.pick_files);
  assert.equal(retry.evidence.retryRequest.params.requestState, retry.evidence.firstResponse.result.requestState);
  assert.equal(retry.evidence.finalResponse.result.resultType, 'complete');
  assert.deepEqual(retry.evidence.finalResponse.result.structuredContent.filesUsed, ['README.md', 'server.py', 'docs/intro.md']);

  const completion = plainMcpValue(logic.evaluateContract(byId(logic.contractScenarios, 'completion')));
  assert.equal(completion.evidence.callRequest.method, 'completion/complete');
  const cursor = plainMcpValue(logic.evaluateContract(byId(logic.contractScenarios, 'cursor')));
  assert.equal(cursor.evidence.callResponse.result.nextCursor, 'cur_J9opaque');
  assert.equal(cursor.evidence.continuationRequest.params.cursor, 'cur_J9opaque');

  const taskInput = plainMcpValue(logic.evaluateTask(byId(logic.taskScenarios, 'input')));
  assert.equal(taskInput.evidence.request.method, 'tasks/get');
  assert.ok(taskInput.evidence.response.result.inputRequests.approve_outline);
  const taskUpdate = plainMcpValue(logic.evaluateTask(byId(logic.taskScenarios, 'update')));
  assert.equal(taskUpdate.evidence.request.method, 'tasks/update');
  assert.equal(taskUpdate.evidence.request.params.inputResponses.approve_outline.action, 'accept');
  const taskCancelled = plainMcpValue(logic.evaluateTask(byId(logic.taskScenarios, 'cancelled')));
  assert.equal(taskCancelled.evidence.request.method, 'tasks/cancel');
  assert.equal(taskCancelled.evidence.after.status, 'cancelled');

  const app = plainMcpValue(logic.evaluateApp(byId(logic.appScenarios, 'lifecycle')));
  const descriptor = app.evidence.toolDiscovery.result.tools[0];
  assert.equal(descriptor._meta.ui.resourceUri, 'ui://notes/timeline.html');
  assert.equal(app.evidence.uiResourceRead.params.uri, descriptor._meta.ui.resourceUri);
  assert.deepEqual(app.evidence.bridge.map(message => message.method).filter(Boolean), [
    'ui/initialize',
    'ui/notifications/initialized',
  ]);

  const collision = plainMcpValue(logic.evaluateMerge(byId(logic.mergeScenarios, 'collision'), 'prefix'));
  assert.deepEqual(collision.evidence.collisions, ['search']);
  assert.equal(collision.evidence.canonicalRouteTable['issues/search'].peer, 'issues');

  const oauth = plainMcpValue(logic.evaluateOAuth(byId(logic.oauthScenarios, 'valid')));
  assert.equal(oauth.evidence.boundaryValues.protectedResource, oauth.evidence.boundaryValues.requestedResource);
  assert.equal(oauth.evidence.boundaryValues.tokenAudience, oauth.evidence.boundaryValues.requestedResource);
  assert.equal(oauth.evidence.boundaryValues.returnedIss, oauth.evidence.boundaryValues.authorizationServer);
  const opaque = plainMcpValue(logic.evaluateJwks(byId(logic.jwksScenarios, 'opaque')));
  assert.equal(opaque.evidence.token.format, 'opaque');
  assert.match(opaque.evidence.actions.join(' '), /introspection/);
  const singleflight = plainMcpValue(logic.evaluateJwks(byId(logic.jwksScenarios, 'singleflight')));
  assert.match(singleflight.evidence.actions.join(' '), /singleflightRefresh/);

  const drift = plainMcpValue(logic.evaluateDrift(byId(logic.driftScenarios, 'aligned')));
  assert.equal(drift.evidence.identityRule, 'display name and serverInfo are not security identity');
  const conformance = plainMcpValue(logic.evaluateConformance(byId(logic.conformanceScenarios, 'unknown-result'), 'differential'));
  assert.equal(conformance.kind, 'nonconformant');
  assert.deepEqual(conformance.evidence.normalizedDiff.map(entry => entry.path), ['$.decision', '$.normalized']);
});

test('MCP contract evaluator follows empty cursors and validates every structuredContent JSON type', () => {
  const logic = loadMcpLabLogic();
  const scenario = id => logic.contractScenarios.find(entry => entry.id === id);

  const emptyCursor = plainMcpValue(logic.evaluateContract(scenario('empty-cursor')));
  assert.equal(emptyCursor.kind, 'valid-complete');
  assert.equal(emptyCursor.tone, 'pass');
  assert.equal(emptyCursor.evidence.callResponse.result.nextCursor, '');
  assert.equal(emptyCursor.evidence.validation.cursorPresent, true);
  assert.equal(emptyCursor.evidence.validation.follow, true);
  assert.equal(emptyCursor.evidence.continuationRequest.params.cursor, '');
  assert.match(emptyCursor.verdict, /even when it is the empty string/i);

  const scalar = plainMcpValue(logic.evaluateContract(scenario('scalar')));
  assert.equal(scalar.kind, 'valid-complete');
  assert.equal(scalar.tone, 'pass');
  assert.equal(scalar.evidence.authoredDefinition.outputSchema.type, 'string');
  assert.equal(typeof scalar.evidence.callResponse.result.structuredContent, 'string');
  assert.equal(scalar.evidence.validation.outputSchemaMatched, true);
  assert.match(scalar.verdict, /any JSON value/i);

  const mismatch = plainMcpValue(logic.evaluateContract(scenario('schema')));
  assert.equal(mismatch.kind, 'protocol-error');
  assert.equal(mismatch.tone, 'fail');
  assert.equal(mismatch.evidence.callResponse.result.isError, true);
  assert.equal(mismatch.evidence.validation.valid, false);
  assert.equal(mismatch.evidence.validation.outputSchemaMatched, false);
  assert.match(mismatch.verdict, /does not waive outputSchema/i);

  const toolError = plainMcpValue(logic.evaluateContract(scenario('tool-error')));
  assert.equal(toolError.kind, 'tool-error');
  assert.equal(toolError.evidence.callResponse.result.isError, true);
  assert.equal(toolError.evidence.validation.valid, true);
  assert.equal(toolError.evidence.validation.outputSchemaMatched, true);
});

test('MCP progress is server-to-client and every reliability Task snapshot is complete', () => {
  const logic = loadMcpLabLogic();
  const byId = (entries, id) => entries.find(entry => entry.id === id);

  assert.ok(logic.requestScenarios.every(scenario => scenario.method !== 'notifications/progress'));
  assert.ok(logic.requestScenarios.every(scenario => scenario.idValue !== null));
  assert.ok(logic.transportScenarios.every(scenario => scenario.mode !== 'notification'));
  assert.ok(logic.dispatchScenarios.every(scenario => scenario.id !== 'notification'));

  const resourceRead = plainMcpValue(logic.evaluateRequestScenario(byId(logic.requestScenarios, 'resource-read')));
  assert.equal(resourceRead.tone, 'pass');
  assert.equal(resourceRead.evidence.request.body.method, 'resources/read');
  assert.equal(resourceRead.evidence.response.body.id, resourceRead.evidence.request.body.id);

  const stream = plainMcpValue(logic.evaluateTransport(byId(logic.transportScenarios, 'request-sse')));
  assert.equal(stream.evidence.request.body.method, 'tools/call');
  assert.equal(stream.evidence.response.progressDirection, 'server-to-client on the request-scoped response');
  assert.equal(stream.evidence.response.events[0].method, 'notifications/progress');
  assert.equal(stream.evidence.response.events[0].params.progressToken, stream.evidence.request.body.params._meta.progressToken);
  assert.equal(stream.evidence.response.events[1].id, stream.evidence.request.body.id);

  const conformance = plainMcpValue(logic.evaluateConformance(byId(logic.conformanceScenarios, 'request-progress'), 'differential'));
  assert.equal(conformance.kind, 'conformant');
  assert.equal(conformance.tone, 'pass');
  assert.equal(conformance.evidence.input.request.method, 'tools/call');
  assert.equal(conformance.evidence.input.responseEvents[0].method, 'notifications/progress');
  assert.equal(conformance.evidence.input.responseEvents[0].params.progressToken, conformance.evidence.input.request.params._meta.progressToken);
  assert.equal(conformance.evidence.input.responseEvents[1].id, conformance.evidence.input.request.id);
  assert.equal(conformance.evidence.expected.normalized.progressDirection, 'server-to-client');

  const toolsListDispatch = plainMcpValue(logic.evaluateDispatch(byId(logic.dispatchScenarios, 'tools-list')));
  assert.equal(toolsListDispatch.kind, 'response');
  assert.equal(JSON.parse(toolsListDispatch.evidence.stdinLine).method, 'tools/list');
  assert.equal(toolsListDispatch.evidence.stdout.id, JSON.parse(toolsListDispatch.evidence.stdinLine).id);

  const taskSnapshots = [];
  const collectTaskSnapshots = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.taskId === 'string' && typeof value.status === 'string') taskSnapshots.push(value);
    Object.values(value).forEach(collectTaskSnapshots);
  };
  for (const scenario of logic.reliabilityScenarios) {
    for (const operation of ['observe', 'request', 'task']) {
      collectTaskSnapshots(plainMcpValue(logic.evaluateReliability(scenario, operation)));
    }
  }
  assert.ok(taskSnapshots.length > 0, 'reliability evaluator did not expose any Task snapshots');
  for (const task of taskSnapshots) {
    assert.equal(typeof task.createdAt, 'string', `Task ${task.taskId} lacks createdAt`);
    assert.equal(typeof task.lastUpdatedAt, 'string', `Task ${task.taskId} lacks lastUpdatedAt`);
    assert.equal(typeof task.ttlMs, 'number', `Task ${task.taskId} lacks ttlMs`);
  }
});

test('MCP registry drift quarantines and deactivates only the drifted release', () => {
  const logic = loadMcpLabLogic();
  const scenario = logic.admissionScenarios.find(entry => entry.id === 'rollback');
  const result = plainMcpValue(logic.evaluateAdmission(scenario));

  assert.equal(result.kind, 'quarantined');
  assert.equal(result.tone, 'fail');
  assert.equal(result.evidence.computedState, 'quarantined');
  assert.equal(result.evidence.currentReleaseState.version, '4.0.0');
  assert.equal(result.evidence.currentReleaseState.quarantined, true);
  assert.equal(result.evidence.currentReleaseState.activeRouting, false);
  assert.match(result.evidence.currentReleaseState.quarantineReason, /descriptor digest/i);
  assert.equal(result.evidence.routingState.releaseVersion, '4.0.0');
  assert.equal(result.evidence.routingState.active, false);
  assert.equal(result.evidence.routingState.action, 'remove-from-active-routing');

  assert.notEqual(result.evidence.rollbackCandidate.version, result.evidence.currentReleaseState.version);
  assert.equal(result.evidence.rollbackCandidate.version, '3.9.2');
  assert.equal(result.evidence.rollbackCandidate.admissionState, 'admitted');
  assert.equal(result.evidence.rollbackCandidate.healthStatus, 'healthy');
  assert.equal(result.evidence.rollbackCandidate.rollbackEligible, true);
  assert.equal(result.evidence.rollbackCandidate.activeRouting, false);
  assert.equal(result.evidence.rollbackCandidate.activationRequires, 'explicit rollback decision');
  assert.match(result.verdict, /separately admitted, healthy 3\.9\.2 release/i);
});

#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  FIGURE_PROVIDER_ORDER,
  buildFigureProviderManifest,
  discoverFigureProviderOrder,
  discoverUsedFigureIds,
  discoverArtifacts,
  parseLearningPaths,
  parseReadme,
  parseRoadmap,
  serializeFigureProviderManifest,
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
    evaluateContract: evaluateContract,
    evaluateTransport: evaluateTransport,
    evaluateRequestScenario: evaluateRequestScenario,
    evaluateDispatch: evaluateDispatch,
    evaluateConformance: evaluateConformance,
    evaluateReliability: evaluateReliability,
    evaluateAdmission: evaluateAdmission
  };
`;
  const context = {
    window: {
      LF: {
        el() {
          throw new Error('DOM rendering must not run in evaluator tests');
        },
        register() {},
      },
    },
    document: {},
  };
  vm.runInNewContext(
    source.replace(registrationMarker, testExport + registrationMarker),
    context,
    { filename: file }
  );
  return context.window.__MCP_LAB_TEST_API;
}

function plainMcpValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadProgressRuntime(seed = {}) {
  const storage = new Map(Object.entries(seed));
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const context = {
    localStorage,
    window: { addEventListener() {} },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'progress.js'), 'utf8'),
    context,
    { filename: path.join(__dirname, 'progress.js') }
  );
  return { api: context.window.AIFSProgress, storage };
}

function loadFigureRuntime({ reducedMotion = false } = {}) {
  let nextFrame = 0;
  let cancelledFrames = 0;
  const scheduledFrames = new Map();
  const windowListeners = {};

  function element(tagName) {
    const listeners = {};
    const node = {
      tagName,
      id: '',
      className: '',
      textContent: '',
      disabled: false,
      hidden: false,
      dataset: {},
      attributes: {},
      children: [],
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') this.id = String(value);
        if (name === 'class') this.className = String(value);
      },
      getAttribute(name) { return this.attributes[name] || null; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, before) {
        child.parentNode = this;
        const index = before ? this.children.indexOf(before) : -1;
        if (index >= 0) this.children.splice(index, 0, child);
        else this.children.push(child);
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(type, handler) { listeners[type] = handler; },
      removeEventListener(type) { delete listeners[type]; },
      click() { if (listeners.click) listeners.click({ target: this }); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    Object.defineProperty(node, 'firstChild', {
      get() { return this.children.length ? this.children[0] : null; },
    });
    node.classList = {
      add(name) {
        const names = new Set(node.className.split(/\s+/).filter(Boolean));
        names.add(name);
        node.className = [...names].join(' ');
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter(value => value && value !== name).join(' ');
      },
      contains(name) { return node.className.split(/\s+/).includes(name); },
      toggle(name, force) {
        if (force) this.add(name);
        else this.remove(name);
      },
    };
    return node;
  }

  const head = element('head');
  const document = {
    hidden: false,
    head,
    createElement: element,
    createElementNS(_namespace, tagName) { return element(tagName); },
    createTextNode(text) { return { textContent: String(text), parentNode: null }; },
    getElementById(id) { return head.children.find(child => child.id === id) || null; },
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    document,
    matchMedia() { return { matches: reducedMotion }; },
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      scheduledFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      if (scheduledFrames.delete(id)) cancelledFrames++;
    },
    addEventListener(type, handler) { windowListeners[type] = handler; },
    removeEventListener(type) { delete windowListeners[type]; },
  };
  const context = {
    console,
    document,
    performance: { now() { return 0; } },
    window,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'lesson-figures.js'), 'utf8'),
    context,
    { filename: path.join(__dirname, 'lesson-figures.js') }
  );
  return {
    window,
    element,
    scheduledFrames,
    dispatchWindow(type) { if (windowListeners[type]) windowListeners[type](); },
    cancelledFrames() { return cancelledFrames; },
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
    quickStart: {
      lessonPath: 'phases/13-tools-and-protocols/22-skills-and-agent-sdks',
      estimatedMinutes: 10,
      command: 'python3 code/main.py',
    },
    lessons: [
      {
        order: 1,
        path: 'phases/13-tools-and-protocols/22-skills-and-agent-sdks',
        title: 'Stale title',
        minutes: 90,
        group: 'core',
        checkpointEvidence: ['A real host invocation transcript.'],
      },
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
  assert.equal(learningPath.lessons[0].minutes, 90);
  assert.equal(learningPath.lessons[0].group, 'core');
  assert.deepEqual(learningPath.lessons[0].checkpointEvidence, ['A real host invocation transcript.']);
  assert.equal(learningPath.quickStart.estimatedMinutes, 10);
  assert.equal(learningPath.quickStart.command, 'python3 code/main.py');
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

test('repository exposes the canonical Model Context Protocol learning path only', () => {
  const root = path.resolve(__dirname, '..');
  const roadmap = parseRoadmap(fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8'));
  const phases = parseReadme(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), roadmap);
  const learningPaths = parseLearningPaths(root, phases);
  const modelContextProtocol = learningPaths.find(entry => entry.id === 'model-context-protocol');

  assert.ok(modelContextProtocol);
  assert.equal(modelContextProtocol.title, 'Model Context Protocol (MCP)');
  assert.equal(modelContextProtocol.lessons[0].path, 'phases/13-tools-and-protocols/06-mcp-fundamentals');
  assert.equal(learningPaths.some(entry => entry.id === 'mcp-engineering'), false);
  assert.equal(fs.existsSync(path.join(root, 'learning-paths', 'mcp-engineering.json')), false);
});

test('homepage routes loop, graph, and harness engineering to real lessons', () => {
  const root = path.resolve(__dirname, '..');
  const homepage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const routes = [
    ['Loop engineering', 'phases/14-agent-engineering/01-the-agent-loop'],
    ['Graph engineering', 'phases/14-agent-engineering/13-langgraph-stateful-graphs'],
    ['Harness engineering', 'phases/14-agent-engineering/31-agent-workbench-why-models-fail'],
  ];

  for (const [label, lessonPath] of routes) {
    assert.ok(fs.existsSync(path.join(root, lessonPath, 'docs', 'en.md')), `${label} lesson docs are missing`);
    assert.ok(fs.existsSync(path.join(root, lessonPath, 'code')), `${label} lesson code is missing`);
    assert.match(homepage, new RegExp(`>${label}<`, 'i'));
    assert.match(homepage, new RegExp(`lesson\\.html\\?path=${lessonPath}`));
    assert.match(homepage, new RegExp(`github\\.com/rohitg00/ai-engineering-from-scratch/tree/main/${lessonPath}`));
  }

  assert.equal((homepage.match(/lesson\.html\?path=phases\/14-agent-engineering\/01-the-agent-loop/g) || []).length, 1);
  assert.match(homepage, /Build agent state-graph orchestration/);
});

test('homepage preserves live GitHub CTAs and the motion-aware learner marquee', () => {
  const homepage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const headerSource = fs.readFileSync(path.join(__dirname, 'header.js'), 'utf8');
  const mastheadCta = homepage.match(/<div class="masthead-cta[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="masthead-install/);
  const learnerStrip = homepage.match(/<section class="learners-strip"[\s\S]*?<\/section>/);
  const learnerStyles = homepage.match(/\/\* Learner organization index \*\/([\s\S]*?)\.masthead-install-caption/);

  assert.ok(mastheadCta, 'prominent masthead CTA row is missing');
  assert.match(
    mastheadCta[0],
    /<a class="masthead-btn" href="https:\/\/github\.com\/rohitg00\/ai-engineering-from-scratch"[^>]*aria-label="Star ai-engineering-from-scratch on GitHub"[^>]*>[\s\S]*?<span>Star on GitHub<\/span>[\s\S]*?<span class="masthead-btn-count" data-gh-stars="rohitg00\/ai-engineering-from-scratch" data-loading="true">/
  );
  assert.match(
    mastheadCta[0],
    /<a class="masthead-btn" href="https:\/\/github\.com\/rohitg00"[^>]*aria-label="Follow Rohit Ghumare on GitHub"[^>]*>[\s\S]*?<span>Follow @rohitg00<\/span>/
  );
  assert.match(homepage, /<script src="header\.js\?v=[^"]+" defer><\/script>/);
  assert.match(headerSource, /\[data-gh-stars="' \+ REPO \+ '"\]/);
  assert.match(headerSource, /fetch\('https:\/\/api\.github\.com\/repos\/' \+ REPO/);
  assert.match(headerSource, /var n = data\.stargazers_count;[\s\S]*?paint\(n\)/);

  assert.ok(learnerStrip, 'institution and company learner strip is missing');
  assert.match(learnerStrip[0], /data-marquee/);
  assert.match(learnerStrip[0], /class="marquee-track"/);
  assert.match(learnerStrip[0], /class="marquee-half"/);
  assert.ok((learnerStrip[0].match(/class="marquee-item/g) || []).length >= 12);
  ['Apple', 'Google', 'OpenAI', 'UC Berkeley', 'Stanford', 'MIT'].forEach(name => {
    assert.ok(learnerStrip[0].includes(name), `learner marquee is missing ${name}`);
  });

  assert.ok(learnerStyles, 'learner marquee styles are missing');
  assert.match(learnerStyles[0], /\.marquee-track\s*\{[\s\S]*?width: max-content/);
  assert.match(learnerStyles[0], /\.marquee\.is-ready \.marquee-track\s*\{[\s\S]*?animation: marquee-left var\(--marquee-dur, 36s\) linear infinite/);
  assert.match(learnerStyles[0], /@keyframes marquee-left\s*\{\s*to\s*\{\s*transform: translateX\(-50%\)/);
  assert.match(homepage, /querySelectorAll\('\[data-marquee\]'\)/);
  assert.match(homepage, /clone = half\.cloneNode\(true\);[\s\S]*?clone\.setAttribute\('aria-hidden', 'true'\);[\s\S]*?track\.appendChild\(clone\)/);
  assert.match(homepage, /marquee\.classList\.add\('is-ready'\)/);

  assert.match(learnerStyles[0], /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.marquee\s*\{[\s\S]*?overflow-x: auto/);
  assert.match(learnerStyles[0], /\.marquee\.is-ready \.marquee-track\s*\{[\s\S]*?animation: none;[\s\S]*?transform: none/);
  assert.match(learnerStyles[0], /\.marquee-track > \[aria-hidden="true"\]\s*\{\s*display: none/);
  assert.match(homepage, /if \(reducedMotion\.matches \|\| !half\.offsetWidth\) return/);
  assert.match(homepage, /reducedMotion\.addEventListener\('change', buildAll\)/);
});

test('website motion contracts keep interaction state stable and compositor-friendly', () => {
  const homepage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const agentSource = fs.readFileSync(path.join(__dirname, 'figures-agents-alignment.js'), 'utf8');
  const ttsSource = fs.readFileSync(path.join(__dirname, 'tts.js'), 'utf8');
  const roadmapSource = fs.readFileSync(path.join(__dirname, 'roadmap.js'), 'utf8');

  const homepageStatBar = homepage.match(/\.stat-row-bar::before\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(homepageStatBar, 'homepage stat bar rule is missing');
  assert.match(homepageStatBar[0], /transform: scaleX\(var\(--bar-scale, 0\)\)/);
  assert.match(homepageStatBar[0], /transition: transform/);
  assert.doesNotMatch(homepageStatBar[0], /transition:\s*width/);
  assert.match(appSource, /barFill\.style\.transform = 'scaleX\('/);
  assert.doesNotMatch(appSource, /barFill\.style\.width\s*=/);

  const agentLoop = agentSource.match(/function agentLoop\(host\) \{[\s\S]*?\n  \}\n\n  \/\/ .* react-trace/);
  assert.ok(agentLoop, 'persistent Agent Loop renderer is missing');
  const agentSteps = agentLoop[0].match(/var steps = \[([\s\S]*?)\n    \];/);
  assert.ok(agentSteps, 'Agent Loop step sequence is missing');
  assert.equal((agentSteps[1].match(/\{ node:/g) || []).length, 12);
  assert.match(agentLoop[0], /transition:stroke 180ms[^'\"]*,opacity 180ms/);
  assert.doesNotMatch(agentLoop[0], /transition:[^'\"]*stroke-width/);
  assert.doesNotMatch(agentLoop[0], /edgeEls\[i\]\.setAttribute\('stroke-width'/);
  assert.match(agentLoop[0], /STEP ' \+ \(state\.step \+ 1\) \+ ' OF 12/);

  const place = ttsSource.match(/function place\(x, y, persist, limits\) \{[\s\S]*?\n  \}/);
  const placeDuringDrag = ttsSource.match(/function placeDuringDrag\(x, y, limits\) \{[\s\S]*?\n  \}/);
  assert.ok(place && placeDuringDrag, 'TTS placement functions are missing');
  assert.match(place[0], /style\.transform = 'translate3d\('/);
  assert.match(placeDuringDrag[0], /style\.transform = 'translate3d\('/);
  assert.doesNotMatch(place[0] + placeDuringDrag[0], /style\.(?:left|top)\s*=/);
  assert.match(ttsSource, /if \(!els\.bar \|\| els\.bar\.classList\.contains\('is-placed'\)\) return;/);
  assert.match(ttsSource, /function glide\(now\)[\s\S]*?place\(x, y, false, limits\)/);
  assert.match(ttsSource, /return !!\(reducedMotion && reducedMotion\.matches\)/);
  assert.match(ttsSource, /if \(event\.matches\) commitDragInertiaForReducedMotion\(\)/);
  assert.match(ttsSource, /reducedMotion\.addEventListener\('change', reducedMotionListener\)/);

  assert.match(roadmapSource, /group\.addEventListener\('keydown'[\s\S]*?togglePhaseSelection\(phase\.id, \{ animate: false \}\)/);
  assert.match(roadmapSource, /jump\.addEventListener\('change'[\s\S]*?selectPhase\(id, \{ updateHistory: true, animate: false \}\)/);
  assert.match(roadmapSource, /event\.key === 'Escape'[\s\S]*?clearSelection\(true, \{ animate: false \}\)/);
  assert.match(roadmapSource, /var keyboardTriggered = event\.detail === 0;[\s\S]*?animate: !keyboardTriggered/);
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

  assert.match(lessonHtml, /'mcp-engineering': 'model-context-protocol'/);
  assert.match(lessonHtml, /requestedLearningPathId = LEARNING_PATH_ID_ALIASES\[incomingLearningPathId\]/);
  assert.match(lessonHtml, /searchParams\.set\('learningPath', pathId\)/);
  assert.match(lessonHtml, /Lesson ' \+ \(focusedIndex \+ 1\) \+ ' of ' \+ focusedLessons\.length/);
  assert.match(lessonHtml, /prerequisitePaths: pathEntry/);
  assert.match(lessonHtml, /learningPathPrerequisiteCallout\(nextRequired/);
  assert.match(lessonHtml, /--skill ' \+ skillName \+ ' --full-depth/);
  assert.match(lessonHtml, /class="output-btn output-install-copy"/);
  assert.match(lessonHtml, /class="output-btn output-install-toggle" type="button" aria-expanded="false" aria-controls="' \+ installId/);
  assert.match(lessonHtml, /btn\.setAttribute\('aria-expanded', expanded \? 'true' : 'false'\)/);
  assert.match(lessonHtml, /currentLessonIndex - 1/);
  assert.doesNotMatch(lessonHtml, /currentLessonIndex - 2/);
  assert.match(lessonHtml, /Requires a local clone/);
  assert.doesNotMatch(lessonHtml, /git rev-parse --show-toplevel/);
  assert.match(lessonHtml, /lessonQuizCorrectAnswers\[qid\] = q\.correct/);
  assert.doesNotMatch(lessonHtml, /data-correct=/);
  assert.match(lessonHtml, /\$check-understanding/);
  assert.match(lessonHtml, /\/check-understanding/);
  assert.match(lessonHtml, /Act on this lesson/);
  assert.match(lessonHtml, /data-checkpoint="read"/);
  assert.match(lessonHtml, /data-checkpoint="built"/);
  assert.match(lessonHtml, /data-checkpoint="ran"/);
  assert.match(lessonHtml, /data-checkpoint="evidence"/);
  assert.match(lessonHtml, /data-lesson-complete="true"/);
  assert.match(lessonHtml, /learningPath\.estimatedMinutes/);
  assert.match(lessonHtml, /entry\.checkpointEvidence/);
  assert.match(lessonHtml, /quickStart\.expectedEvidence/);
  assert.match(lessonHtml, /function repoRootCommand\(filename, path\)/);
  assert.equal((lessonHtml.match(/repoRootCommand\(file\.name, filePath\)/g) || []).length, 2);
  assert.match(lessonHtml, /\.code-card-run \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/);
  assert.doesNotMatch(lessonHtml, /\.code-card-run::-[a-z-]*scrollbar/);
  assert.match(lessonHtml, /Run from the repository root, the folder containing README\.md/);
  assert.match(lessonHtml, /inferLearningPath\(lessonPath\)/);
  assert.match(lessonHtml, /preferredIds = \['agent-skills', 'model-context-protocol'\]/);
  assert.match(lessonHtml, /A code fence is not automatically a runnable program/);
  assert.match(lessonHtml, /var fetchOptions = localPreview \? \{ cache: 'no-store' \} : undefined/);
  assert.match(lessonHtml, /fetch\(primary, fetchOptions\)/);
  assert.doesNotMatch(lessonHtml, /<script src="figures(?:\.js|-)/);
  assert.match(lessonHtml, /<script src="figure-manifest\.js/);
  assert.match(lessonHtml, /import\('https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11/);
});

test('MCP lesson labs override legacy figures with modern inspectable protocol outcomes', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = buildFigureProviderManifest(root, __dirname);
  const moduleSource = fs.readFileSync(path.join(__dirname, 'figures-mcp.js'), 'utf8');
  const legacyIndex = manifest.providerOrder.indexOf('figures-tools3.js');
  const mcpIndex = manifest.providerOrder.indexOf('figures-mcp.js');

  assert.ok(legacyIndex >= 0);
  assert.ok(mcpIndex > legacyIndex);
  assert.deepEqual(manifest.providersByFigure['t3-dispatch-loop'], [
    'figures-tools3.js',
    'figures-mcp.js',
  ]);
  assert.equal(manifest.providersByFigure['mcp-tool-call'].at(-1), 'figures-mcp.js');

  [
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
  ].forEach(figureId => {
    assert.match(moduleSource, new RegExp(`['"]${figureId}['"]\\s*:`));
  });

  assert.doesNotMatch(moduleSource, /repeatCount\s*[:=]/);
  assert.doesNotMatch(moduleSource, /rpcRequest\([^)]*notifications\/progress/);
  assert.doesNotMatch(moduleSource, /httpStatus:\s*202|HTTP 202|202 Accepted|accept-no-response/);
  assert.match(moduleSource, /el\('figure'/);
  assert.match(moduleSource, /el\('figcaption'/);
  assert.match(moduleSource, /'aria-live': 'polite'/);
  assert.match(moduleSource, /'aria-pressed'/);
  assert.match(moduleSource, /prefers-reduced-motion:reduce/);
  assert.match(moduleSource, /@media\(max-width:640px\)/);
  assert.match(moduleSource, /\.mcp-lab__scenario,\.mcp-lab__choice,\.mcp-lab__action\{transition:transform var\(--motion-press,160ms\) var\(--ease-out/);
  assert.match(moduleSource, /\.mcp-lab__stage\{transition:transform var\(--motion-drawer,250ms\) var\(--ease-in-out/);
  assert.match(moduleSource, /opacity var\(--motion-feedback,180ms\) var\(--ease-out/);
  assert.match(moduleSource, /var stageViews = \[\]/);
  assert.match(moduleSource, /if \(stageViews\[index\]\) return stageViews\[index\]/);
  assert.match(moduleSource, /pipeline\.appendChild\(node\)/);
  assert.match(moduleSource, /stageView\.node\.hidden = false/);
  assert.doesNotMatch(moduleSource, /pipeline\.(?:replaceChildren|innerHTML\s*=|textContent\s*=)/);

  [
    'io.modelcontextprotocol/protocolVersion',
    'io.modelcontextprotocol/clientCapabilities',
    'io.modelcontextprotocol/clientInfo',
    'io.modelcontextprotocol/serverInfo',
    'MCP-Protocol-Version',
    'Mcp-Method',
    'Mcp-Name',
    'server/discover',
    'supportedVersions',
    'resultType',
    'structuredContent',
    'outputSchema',
    'subscriptions/listen',
    'io.modelcontextprotocol/subscriptionId',
    'input_required',
    'inputRequests',
    'inputResponses',
    'requestState',
    'tasks/cancel',
    'tasks/get',
    'tasks/update',
    'cancelled',
    'completion/complete',
    'nextCursor',
    '_meta.ui.resourceUri',
    'resourceUri',
    'ui/initialize',
    'ui/notifications/initialized',
    'Exact search collision',
    'protectedResource',
    'tokenAudience',
    'returnedIss',
    'singleflightRefresh',
    'introspection',
    'serverInfo are not security identity',
    'normalizedDiff',
  ].forEach(field => {
    assert.ok(moduleSource.includes(field), `missing MCP lab field: ${field}`);
  });
});

test('figure manifest deterministically routes only providers needed by lesson figure IDs', () => {
  const root = path.resolve(__dirname, '..');
  const first = buildFigureProviderManifest(root, __dirname);
  const second = buildFigureProviderManifest(root, __dirname);
  const usedIds = discoverUsedFigureIds(root);

  assert.deepEqual(first, second);
  assert.deepEqual(first.providerOrder, discoverFigureProviderOrder(__dirname));
  assert.deepEqual(first.providerOrder.slice(0, FIGURE_PROVIDER_ORDER.length), FIGURE_PROVIDER_ORDER);
  assert.equal(
    first.providerVersions['figures.js'],
    crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'figures.js'), 'utf8')).digest('hex').slice(0, 12)
  );
  assert.ok(usedIds.length > 500);
  assert.ok(Object.keys(first.providersByFigure).length < usedIds.length, 'runtime-local figures should not load a provider');
  assert.deepEqual(first.providersByFigure['tokenizer-bpe'], ['figures.js']);
  for (const providers of Object.values(first.providersByFigure)) {
    const indexes = providers.map(provider => first.providerOrder.indexOf(provider));
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  }

  const manifestSource = serializeFigureProviderManifest(first);
  const manifestVersion = crypto.createHash('sha256').update(manifestSource).digest('hex').slice(0, 12);
  const runtimeSource = fs.readFileSync(path.join(__dirname, 'lesson-figures.js'), 'utf8');
  const runtimeVersion = crypto.createHash('sha256').update(runtimeSource).digest('hex').slice(0, 12);
  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  assert.match(manifestSource, /window\.AIFS_FIGURE_PROVIDER_VERSIONS =/);
  assert.match(lessonHtml, new RegExp(`lesson-figures\\.js\\?v=${runtimeVersion}`));
  assert.match(lessonHtml, new RegExp(`figure-manifest\\.js\\?v=${manifestVersion}`));
});

test('new figure provider modules are appended deterministically without disturbing legacy order', t => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefs-figure-providers-'));
  t.after(() => fs.rmSync(siteDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(siteDir, 'figures.js'), '');
  fs.writeFileSync(path.join(siteDir, 'figures-zeta.js'), '');
  fs.writeFileSync(path.join(siteDir, 'figures-agent-skills.js'), '');
  fs.writeFileSync(path.join(siteDir, 'lesson-figures.js'), '');

  assert.deepEqual(discoverFigureProviderOrder(siteDir, ['figures.js']), [
    'figures.js',
    'figures-agent-skills.js',
    'figures-zeta.js',
  ]);
});

test('progress v2 migrates quiz completion and keeps workflow checkpoints distinct', () => {
  const lesson = 'phases/13-tools-and-protocols/06-mcp-fundamentals';
  const legacy = JSON.stringify({
    lessons: {
      [lesson]: {
        answers: { q1: { picked: 1, correct: true, t: 100 } },
        completedAt: 200,
        visitedAt: 50,
      },
    },
    updatedAt: 200,
  });
  const migrated = loadProgressRuntime({ 'aifs:progress:v1': legacy });
  const historical = migrated.api.getLessonProgress(lesson);
  assert.equal(historical.completedAt, 200);
  assert.equal(historical.quizPassedAt, 200);
  assert.equal(historical.completionSource, 'migrated-v1');
  assert.equal(JSON.parse(migrated.storage.get('aifs:progress:v2')).schemaVersion, 2);

  const fresh = loadProgressRuntime();
  fresh.api.recordVisit(lesson);
  fresh.api.setCheckpoint(lesson, 'read', true);
  fresh.api.setCheckpoint(lesson, 'built', true);
  fresh.api.setCheckpoint(lesson, 'ran', true);
  fresh.api.setCheckpoint(lesson, 'evidence', true);
  fresh.api.markQuizPassed(lesson);
  assert.equal(fresh.api.isLessonComplete(lesson), false);
  assert.ok(fresh.api.getLessonProgress(lesson).quizPassedAt);
  assert.ok(fresh.api.getLessonProgress(lesson).checkpoints.evidenceAt);
  fresh.api.markLessonComplete(lesson, 'learner');
  fresh.api.unmarkQuizPassed(lesson);
  assert.equal(fresh.api.isLessonComplete(lesson), true);
  assert.equal(fresh.api.getLessonProgress(lesson).quizPassedAt, null);
});

test('lesson figure runtime mounts once and disposes its animation frame and control', () => {
  const runtime = loadFigureRuntime();
  const host = runtime.element('div');
  host.dataset.figure = 'runtime-test';
  const root = runtime.element('article');
  root.querySelectorAll = selector => selector === '.lesson-figure[data-figure]' ? [host] : [];
  let staticFrames = 0;

  runtime.window.LF.register({
    'runtime-test': figureHost => {
      runtime.window.LF.autoplay(figureHost, () => { staticFrames++; }, 1000, { staticT: 0.5 });
    },
  });
  runtime.window.mountLessonFigures(root);
  runtime.window.mountLessonFigures(root);

  assert.equal(staticFrames, 1, 'a mounted host must not receive a duplicate SVG loop');
  assert.equal(host.dataset.lfMounted, '1');
  const control = host.children.find(child => child.className === 'lf-motion-toggle');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-pressed'), 'false');
  assert.equal(runtime.scheduledFrames.size, 1);

  runtime.dispatchWindow('beforeprint');
  assert.equal(staticFrames, 2);
  assert.equal(runtime.scheduledFrames.size, 0);
  runtime.dispatchWindow('afterprint');
  assert.equal(runtime.scheduledFrames.size, 1);

  control.click();
  assert.equal(control.getAttribute('aria-pressed'), 'true');
  assert.equal(runtime.scheduledFrames.size, 0);
  runtime.window.AIFSFigureRuntime.disposeRoot(root);
  assert.equal(host.dataset.lfMounted, undefined);
  assert.equal(host.children.includes(control), false);
  assert.ok(runtime.cancelledFrames() >= 1);
});

test('reduced motion holds SMIL figures on a meaningful static frame', () => {
  const runtime = loadFigureRuntime({ reducedMotion: true });
  const host = runtime.element('div');
  host.dataset.figure = 'smil-test';
  const svg = runtime.element('svg');
  let staticTime = null;
  let pauses = 0;
  svg.setCurrentTime = value => { staticTime = value; };
  svg.pauseAnimations = () => { pauses++; };
  svg.unpauseAnimations = () => {};
  host.querySelector = selector => selector === 'svg' ? svg : null;
  host.querySelectorAll = selector => {
    if (selector === 'svg') return [svg];
    if (selector.includes('repeatCount="indefinite"')) return [{}];
    return [];
  };
  const root = runtime.element('article');
  root.querySelectorAll = selector => selector === '.lesson-figure[data-figure]' ? [host] : [];
  runtime.window.LF.register({ 'smil-test': figureHost => figureHost.appendChild(svg) });

  runtime.window.mountLessonFigures(root);

  assert.equal(staticTime, 1.5);
  assert.ok(pauses >= 1);
  const control = host.children.find(child => child.className === 'lf-motion-toggle');
  assert.ok(control);
  assert.equal(control.disabled, true);
  assert.equal(control.textContent, 'Motion reduced');
  assert.equal(runtime.scheduledFrames.size, 0);
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

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

test('MCP lesson labs override legacy figures with modern inspectable protocol outcomes', () => {
  const lessonHtml = fs.readFileSync(path.join(__dirname, 'lesson.html'), 'utf8');
  const moduleSource = fs.readFileSync(path.join(__dirname, 'figures-mcp.js'), 'utf8');
  const legacyIndex = lessonHtml.indexOf('figures-tools3.js?v=20260821a');
  const mcpIndex = lessonHtml.indexOf('figures-mcp.js?v=20260821a');

  assert.ok(legacyIndex >= 0);
  assert.ok(mcpIndex > legacyIndex);

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
  assert.match(moduleSource, /transform 250ms var\(--ease-in-out\)/);
  assert.match(moduleSource, /opacity 180ms var\(--ease-out\)/);

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

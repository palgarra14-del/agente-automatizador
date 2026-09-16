import assert from 'node:assert/strict';
import {
  BrowserQaCoordinator,
  browserQaFingerprint,
  createBrowserQaRequest
} from '../src/browser-qa.js';
import { ChromeBrowserQaRunner } from '../src/browser-qa-runner.js';

const anchors = ['inicio', 'servicios', 'inspiracion', 'experiencia', 'preguntas', 'contacto'];
const websiteBlueprint = {
  version: 1,
  profileId: 'beauty-salon-historical-dogfood',
  sourceBriefFingerprint: 'a'.repeat(64),
  pages: [{
    id: 'home',
    route: '/',
    source: 'historical-lumina-dogfood',
    sections: anchors
  }],
  requiredFeatures: [],
  contentSources: { services: [], facts: [], locations: [] },
  ctas: [{
    id: 'primary',
    kind: 'section',
    destination: '#contacto',
    source: null
  }],
  navigation: {
    routes: [{ id: 'home', route: '/' }],
    homeAnchors: anchors.map((anchor) => `#${anchor}`)
  },
  responsiveRequirements: [],
  accessibilityRequirements: [],
  seoRequirements: { locationSources: [], serviceSources: [], requirements: [] },
  assets: { allowedProvenance: ['missing'], slots: [] },
  forbiddenClaims: [],
  missingFactSources: []
};

const request = createBrowserQaRequest({
  workflowId: 'workflow-77c4a1bb-a33a-4165-93ab-64f893e002ef',
  websiteBlueprintFingerprint: browserQaFingerprint(websiteBlueprint),
  reviewedChangeSetFingerprint: '8afe44584250a94221671b3ddb212902d539746ab6355f30cf9676668a2b5cbc',
  publishedCommitSha: '9a981cffee6febf3bb6bee888a8effdfd6cc7445',
  previewUrl: 'https://zasert-kb1on3aju-pabloproyectosgit.vercel.app/',
  websiteBlueprint
});

const coordinator = new BrowserQaCoordinator({
  runner: new ChromeBrowserQaRunner(),
  timeoutMs: 30_000
});

const result = await coordinator.verify(request);
console.log(JSON.stringify({
  requestFingerprint: request.requestFingerprint,
  evidence: result.evidence
}, null, 2));
assert.equal(result.evidence.status, 'pass', `Lúmina Browser QA dogfood expected PASS, got ${result.evidence.status}: ${result.evidence.unavailableReason ?? 'deterministic defects'}`);
console.log('Lúmina real-preview Browser QA dogfood PASS');

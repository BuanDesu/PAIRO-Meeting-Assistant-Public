import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoleForPlatform } from '../src/platform.js';

test('native Android starts as the phone role while browsers keep desktop default', () => {
  assert.equal(defaultRoleForPlatform('android'), 'mobile');
  assert.equal(defaultRoleForPlatform('web'), 'desktop');
  assert.equal(defaultRoleForPlatform('ios'), 'desktop');
});

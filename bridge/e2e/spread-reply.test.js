import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadSucceeded } from './spread-reply.js';

test('accepts the vanilla spreadplayers success reply', () => {
  assert.equal(spreadSucceeded('Spread 1 player(s) around 6800.5, 4880.5'), true);
});

test('accepts the alternate success wording', () => {
  assert.equal(spreadSucceeded('Successfully spread entities'), true);
});

test('rejects the observed failure reply', () => {
  assert.equal(spreadSucceeded('Could not spread 1 entity/entities around 6800.5, 4880.5 (too many entities for space - try using spread of at most 0.00)'), false);
});

test('rejects an empty reply', () => {
  assert.equal(spreadSucceeded(''), false);
});

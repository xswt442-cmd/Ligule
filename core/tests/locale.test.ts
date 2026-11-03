import test from 'node:test';
import assert from 'node:assert/strict';
import { languageOf, textOf } from '../dist/kernel/locale.js';

test('locale selection accepts built-in values and follows the system locale for auto', () => {
  assert.equal(languageOf('zh', 'en-US'), 'zh');
  assert.equal(languageOf('zh-CN', 'en-US'), 'zh');
  assert.equal(languageOf('en', 'zh-CN'), 'en');
  assert.equal(languageOf('auto', 'zh-HK'), 'zh');
  assert.equal(languageOf(undefined, 'en-GB'), 'en');
  assert.equal(textOf('zh', '中文', 'English'), '中文');
  assert.equal(textOf('en', '中文', 'English'), 'English');
});

test('unsupported locale values have a stable error code', () => {
  assert.throws(() => languageOf('fr', 'fr-FR'), { code: 'language_invalid' });
});

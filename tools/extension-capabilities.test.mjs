import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectExtensionCapability,
  listExtensionCapabilities,
  normalizedPascalType,
  parameterWireAdapter,
  registerExtensionCapability,
  resultWireAdapter,
} from './extension-capabilities.mjs';

test('normalizes legacy type spelling and comments', () => {
  assert.equal(normalizedPascalType('TVariantArray2D // grid values'), 'tvariantarray2d');
  assert.equal(normalizedPascalType(' TColor { Lazarus alias } '), 'tcolor');
  assert.equal(normalizedPascalType('Variant (* angle *)'), 'variant');
});

test('describes scalar, legacy boolean, color and 2d array wire adapters', () => {
  assert.equal(parameterWireAdapter({ name: 'Color', type: 'TColor', qualifier: '' }).supported, true);
  assert.deepEqual(
    parameterWireAdapter({ name: 'Rows', type: 'TVariantArray2d', qualifier: '' }),
    {
      supported: true,
      issue: '',
      wireType: 'json-array-2d',
      encoder: 'ExtensionProviderEncodeVariantArray2d',
    },
  );
  assert.equal(resultWireAdapter('ByteBool'), 'ExtensionProviderCallBoolean');
});

test('rejects types that cannot cross the provider boundary', () => {
  assert.match(
    parameterWireAdapter({ name: 'Owner', type: 'TObject', qualifier: '' }).issue,
    /unsupported-parameter-type:TObject/,
  );
  assert.match(
    parameterWireAdapter({ name: 'Value', type: 'Integer', qualifier: 'var' }).issue,
    /by-reference-parameter:Value/,
  );
});

test('allows capability packs to register a detector without changing the migrator', () => {
  const id = `test.dynamic-${Date.now()}`;
  registerExtensionCapability({
    id,
    title: 'Dynamic test capability',
    execution: 'provider',
    detect(context) {
      return context.operation === 'DYNAMIC_TEST' ? { kind: 'test-handler' } : null;
    },
  });
  const detected = detectExtensionCapability({
    operation: 'DYNAMIC_TEST',
    params: [],
    type: '',
    spec: {},
    inline: { issues: [] },
    report: { findings: [] },
    source: '',
  });
  assert.equal(detected.capability, id);
  assert.equal(detected.kind, 'test-handler');
  assert.ok(listExtensionCapabilities().some(item => item.id === id));
});

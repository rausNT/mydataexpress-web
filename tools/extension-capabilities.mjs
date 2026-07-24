/**
 * Declarative capability registry used by the extension migrator.
 *
 * Keep platform-specific recognition here instead of teaching the migrator
 * individual extension names. Additional capability packs can register a
 * detector through registerExtensionCapability().
 */

export const CAPABILITY_REGISTRY_VERSION = 1;

const stringTypes = new Set(['string', 'ansistring', 'unicodestring', 'widestring']);
const booleanTypes = new Set(['boolean', 'bool', 'bytebool']);
const integerTypes = new Set([
  'byte', 'shortint', 'smallint', 'word', 'integer', 'longint', 'cardinal',
  'longword', 'int64', 'qword', 'nativeint', 'nativeuint', 'tcolor',
]);
const floatTypes = new Set(['single', 'double', 'extended', 'real', 'currency', 'comp']);
const dateTypes = new Set(['tdatetime', 'tdate', 'ttime']);
const characterTypes = new Set(['char', 'ansichar', 'widechar']);

export function normalizedPascalType(type) {
  return String(type || '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{[^}]*\}?/g, '')
    .replace(/\(\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function parameterWireAdapter(parameter) {
  if (parameter.qualifier === 'var' || parameter.qualifier === 'out') {
    return {
      supported: false,
      issue: `by-reference-parameter:${parameter.name}`,
      wireType: '',
      encoder: '',
    };
  }
  const type = normalizedPascalType(parameter.type);
  if (stringTypes.has(type) || booleanTypes.has(type) || integerTypes.has(type) ||
      floatTypes.has(type) || dateTypes.has(type) || type === 'variant' ||
      characterTypes.has(type)) {
    return {
      supported: true,
      issue: '',
      wireType: type === 'variant' ? 'json-value' : 'json-scalar',
      encoder: 'ExtensionProviderEncodeValue',
    };
  }
  if (type === 'tvariantarray2d') {
    return {
      supported: true,
      issue: '',
      wireType: 'json-array-2d',
      encoder: 'ExtensionProviderEncodeVariantArray2d',
    };
  }
  return {
    supported: false,
    issue: `unsupported-parameter-type:${parameter.type || 'unknown'}`,
    wireType: '',
    encoder: '',
  };
}

export function resultWireAdapter(type) {
  const normalized = normalizedPascalType(type);
  if (stringTypes.has(normalized)) return 'ExtensionProviderCall';
  if (booleanTypes.has(normalized)) return 'ExtensionProviderCallBoolean';
  if (integerTypes.has(normalized)) return 'ExtensionProviderCallInt64';
  if (floatTypes.has(normalized)) return 'ExtensionProviderCallFloat';
  if (dateTypes.has(normalized)) return 'ExtensionProviderCallDateTime';
  if (normalized === 'variant') return 'ExtensionProviderCallVariant';
  return '';
}

export function isStringType(type) {
  return stringTypes.has(normalizedPascalType(type));
}

const capabilities = [];

export function registerExtensionCapability(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Capability definition must be an object');
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(definition.id || '')) {
    throw new TypeError(`Invalid capability id: ${definition.id || ''}`);
  }
  if (typeof definition.detect !== 'function') {
    throw new TypeError(`Capability ${definition.id} must provide detect(context)`);
  }
  if (capabilities.some(item => item.id === definition.id)) {
    throw new TypeError(`Duplicate capability id: ${definition.id}`);
  }
  capabilities.push(Object.freeze({ ...definition }));
}

export function listExtensionCapabilities() {
  return capabilities.map(({ detect, ...definition }) => ({ ...definition }));
}

export function detectExtensionCapability(context) {
  for (const capability of capabilities) {
    const recipe = capability.detect(context);
    if (!recipe) continue;
    return {
      capability: capability.id,
      registryVersion: CAPABILITY_REGISTRY_VERSION,
      ...recipe,
    };
  }
  return null;
}

function hasFinding(context, rule) {
  return context.report.findings.some(finding => finding.rule === rule);
}

function replacesOle(context) {
  return context.inline.issues.some(issue =>
    issue.includes('platform-dependency:ole'));
}

function dadataStateVariables(source) {
  return [...new Set([...source.matchAll(
    /"((?:data\.)[A-Za-z0-9_.]+|unrestricted_value|value)"/g,
  )].map(match => match[1]))];
}

registerExtensionCapability({
  id: 'network.http-request',
  title: 'HTTP request',
  execution: 'provider',
  detect(context) {
    const { spec, operation, params, type, source } = context;
    if (!hasFinding(context, 'network') || !/\bTHTTPClient\b/i.test(source) ||
        !/\bSendHttpRequest\s*\(/i.test(source)) return null;

    const stringParameters = params.every(parameter => isStringType(parameter.type));
    if (spec.kind === 'function' &&
        String(spec.origName || operation).toLowerCase() === 'sendhttprequestfunction' &&
        normalizedPascalType(type) === 'variant' && params.length === 5 && stringParameters &&
        /\bHeadersList\.CommaText\s*:=/i.test(source)) {
      return {
        kind: 'http-request',
        contract: 'send-http-request-function-v1',
        methodParameter: params[0].name,
        urlParameter: params[1].name,
        headersParameter: params[2].name,
        apiKeyParameter: params[3].name,
        paramsParameter: params[4].name,
      };
    }

    const actionTypes = params.map(parameter => normalizedPascalType(parameter.type));
    if (spec.kind === 'action' &&
        String(spec.origName || '').toLowerCase() === 'sendhttprequestaction' &&
        String(operation).toUpperCase() === 'B2C1C477-85A4-4133-9D9C-0FD61CA10F1C' &&
        params.length === 7 &&
        actionTypes.slice(0, 5).every(value => stringTypes.has(value)) &&
        actionTypes.slice(5).every(value => value === 'tvariantarray2d') &&
        /\brequest_result\b/i.test(source) &&
        /\bCreateJSONFromParams\s*\(/i.test(source)) {
      return {
        kind: 'http-request',
        contract: 'send-http-request-action-v1',
        methodParameter: params[0].name,
        urlParameter: params[1].name,
        authTypeParameter: params[2].name,
        authValueParameter: params[3].name,
        contentTypeParameter: params[4].name,
        headersParameter: params[5].name,
        paramsParameter: params[6].name,
      };
    }
    return null;
  },
});

registerExtensionCapability({
  id: 'network.http-get',
  title: 'Legacy HTTP GET',
  execution: 'provider',
  detect(context) {
    const { spec, operation, params, type } = context;
    const parameterSupported = params.length === 1 &&
      (normalizedPascalType(params[0].type) === 'variant' ||
        isStringType(params[0].type));
    if (spec.kind !== 'function' || operation.toUpperCase() !== 'HTTP_GET' ||
        !isStringType(type) || !parameterSupported ||
        !hasFinding(context, 'network') || !replacesOle(context)) return null;
    return {
      kind: 'http-get',
      urlParameter: params[0].name,
    };
  },
});

registerExtensionCapability({
  id: 'network.dadata-suggest',
  title: 'DaData suggestions',
  execution: 'provider',
  detect(context) {
    const { spec, operation, params, type, source } = context;
    const dadataTypes = {
      DA_FIRM_GET: ['party', 'DA_FIRM_FIELD'],
      DA_BANK_GET: ['bank', 'DA_BANK_GET'],
      DA_ADDR_GET: ['address', 'DA_ADDR_FIELD'],
    };
    const dadata = dadataTypes[operation.toUpperCase()];
    const parametersSupported = params.length === 2 && params.every(parameter =>
      normalizedPascalType(parameter.type) === 'variant' ||
      isStringType(parameter.type));
    if (!dadata || spec.kind !== 'function' || !isStringType(type) ||
        !parametersSupported || !replacesOle(context) ||
        !/suggestions\.dadata\.ru/i.test(source) ||
        !/\bGetXMLData\s*\(/i.test(source)) return null;
    return {
      kind: 'dadata-suggest',
      suggestType: dadata[0],
      apiKeyParameter: params[0].name,
      queryParameter: params[1].name,
      stateVariables: dadataStateVariables(source),
      resultVariable: dadata[1],
    };
  },
});

registerExtensionCapability({
  id: 'documents.office-convert',
  title: 'Office document conversion',
  execution: 'provider',
  detect(context) {
    const { spec, operation, params, type, source } = context;
    const officeTypes = {
      convert_word: {
        documentType: 'writer',
        signature: /\bWord\.Application\b/i,
        conversion: /\b(?:SaveAs2|ExportAsFixedFormat)\s*\(/i,
      },
      convert_excel: {
        documentType: 'calc',
        signature: /\bExcel\.Application\b/i,
        conversion: /\b(?:SaveAs|ExportAsFixedFormat)\s*\(/i,
      },
    };
    const office = officeTypes[String(spec.origName || operation).toLowerCase()];
    const parametersSupported = params.length === 3 &&
      params.every(parameter => isStringType(parameter.type));
    if (!office || spec.kind !== 'action' ||
        normalizedPascalType(type) !== 'boolean' ||
        !parametersSupported || !replacesOle(context) ||
        !office.signature.test(source) || !office.conversion.test(source)) return null;
    return {
      kind: 'office-document-convert',
      documentType: office.documentType,
      inputParameter: params[0].name,
      outputParameter: params[1].name,
      formatParameter: params[2].name,
    };
  },
});

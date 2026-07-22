export class ProviderConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderConfigError';
    this.details = details;
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (/^(true|yes|on|1)$/i.test(value)) return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  throw new ProviderConfigError(`Invalid boolean value: ${value}`);
}

function effectiveTimeout(value) {
  if (value === undefined || value === '') return 30000;
  if (!/^\d+$/.test(value)) throw new ProviderConfigError(`Invalid TimeoutMs value: ${value}`);
  return Math.min(300000, Math.max(1000, Number(value)));
}

export function parseProviderConfig(source) {
  const sections = new Map();
  const errors = [];
  const warnings = [];
  let current = null;

  String(source).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) return;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      const key = name.toLowerCase();
      if (sections.has(key)) {
        errors.push({ code: 'duplicate-section', section: name, line: index + 1 });
        current = sections.get(key);
        return;
      }
      current = { name, values: new Map(), line: index + 1 };
      sections.set(key, current);
      return;
    }
    const separator = rawLine.indexOf('=');
    if (separator < 0 || !current) {
      warnings.push({ code: 'ignored-line', line: index + 1 });
      return;
    }
    const name = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    const key = name.toLowerCase();
    if (current.values.has(key)) {
      warnings.push({ code: 'duplicate-key', section: current.name, key: name, line: index + 1 });
    }
    current.values.set(key, value);
  });

  const providers = [];
  for (const section of sections.values()) {
    if (!section.name.toLowerCase().startsWith('provider:')) continue;
    const name = section.name.slice('provider:'.length).trim();
    if (!name) {
      errors.push({ code: 'provider-name-required', section: section.name, line: section.line });
      continue;
    }
    try {
      providers.push({
        name,
        url: section.values.get('url') || '',
        token: section.values.get('token') || '',
        timeoutMs: effectiveTimeout(section.values.get('timeoutms')),
        allowInsecure: parseBoolean(section.values.get('allowinsecure'), false),
        section: section.name,
      });
    } catch (error) {
      errors.push({
        code: 'invalid-provider-value',
        section: section.name,
        message: error.message,
      });
    }
  }

  const providerNames = new Set();
  for (const provider of providers) {
    const key = provider.name.toLowerCase();
    if (providerNames.has(key)) {
      errors.push({ code: 'duplicate-provider', provider: provider.name });
    }
    providerNames.add(key);
  }
  return { providers, errors, warnings };
}

export function findProvider(configuration, name) {
  return configuration.providers.find(provider =>
    provider.name.toLowerCase() === String(name).toLowerCase()
  ) || null;
}

export function validateProviderEndpoint(provider) {
  const errors = [];
  const warnings = [];
  if (!provider) return { errors: [{ code: 'provider-section-missing' }], warnings };
  if (!provider.url) return { errors: [{ code: 'provider-url-required' }], warnings };

  let url;
  try {
    url = new URL(provider.url);
  } catch {
    return { errors: [{ code: 'provider-url-invalid' }], warnings };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    errors.push({ code: 'provider-url-protocol' });
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback && !provider.allowInsecure) {
    errors.push({ code: 'provider-https-required' });
  }
  if (!provider.token) warnings.push({ code: 'provider-token-empty' });
  return { url, errors, warnings };
}

export function configuredProviderNames(configuration) {
  return new Set(configuration.providers
    .filter(provider => validateProviderEndpoint(provider).errors.length === 0)
    .map(provider => provider.name.toLowerCase()));
}

import { createProviderServer, listenProvider } from '../../tools/provider-sdk.mjs';

const token = process.env.DX_PROVIDER_TOKEN;
if (!token) throw new Error('DX_PROVIDER_TOKEN is required');

const handlers = {
  NORMALIZE_PHONE(payload) {
    return String(payload.Value || '').replace(/[^+\d]/g, '');
  },

  'action-123'(payload, context) {
    return {
      accepted: true,
      fileName: payload.FileName || '',
      provider: context.provider,
    };
  },
};

const manifest = {
  schemaVersion: 1,
  provider: 'OfficeTools',
  mappings: Object.keys(handlers).map(operation => ({ operation, status: 'provider' })),
};

const server = createProviderServer({ token, manifest, handlers });

const url = await listenProvider(server, {
  host: process.env.DX_PROVIDER_HOST || '127.0.0.1',
  port: Number(process.env.DX_PROVIDER_PORT || 9081),
});

console.log(`DataExpress provider listening at ${url}`);

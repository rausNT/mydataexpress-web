import { createProviderServer, listenProvider } from '../../tools/provider-sdk.mjs';

const token = process.env.DX_PROVIDER_TOKEN;
if (!token) throw new Error('DX_PROVIDER_TOKEN is required');

const server = createProviderServer({
  token,
  handlers: {
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
  },
});

const url = await listenProvider(server, {
  host: process.env.DX_PROVIDER_HOST || '127.0.0.1',
  port: Number(process.env.DX_PROVIDER_PORT || 9081),
});

console.log(`DataExpress provider listening at ${url}`);

import { createProviderServer, listenProvider } from './provider-sdk.mjs';

const port = Number(process.argv[2] || 19081);
const token = process.argv[3] || 'provider-smoke-secret';

const server = createProviderServer({
  token,
  handlers: {
    echo_types(payload) {
      const valid = typeof payload.text === 'string' &&
        typeof payload.enabled === 'boolean' &&
        typeof payload.count === 'number' &&
        typeof payload.amount === 'number';
      if (!valid) throw new Error(`Payload types were not preserved: ${JSON.stringify(payload)}`);
      return 'types-ok';
    },
    boolean_value() { return true; },
    integer_value() { return 42; },
    float_value() { return 12.5; },
    datetime_value() { return '2026-07-22T12:34:56Z'; },
    variant_value() { return { accepted: true }; },
  },
});

const url = await listenProvider(server, { host: '127.0.0.1', port });
console.log(`provider-smoke-ready ${url}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
